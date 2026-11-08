import {
    NativeOperationError,
    SipbridgeSignaling,
    type IncomingSipRequest,
    type NativeDialog,
    type OutboundAttempt,
    type SipResponse
} from './sipbridge-signaling';
import { randomUUID } from 'node:crypto';

import type { ActiveCall } from './call-registry';
import { CallRegistry } from './call-registry';
import type { GatewayConfig } from './config';
import { ControlConnectionUnavailableError, ControlHub } from './control-hub';
import {
    type FollowUpHttpEvent,
    type InviteHttpRequest,
    type SipAction,
    type SipHeaders,
    InvalidHttpActionError,
    parseSipActionResponse
} from './http-contract';
import { type GatewayHttpClient, HttpPostError } from './http-client';
import { BaseLogger } from './logger';
import { GatewayDrainingError, GatewayLifecycle } from './gateway-lifecycle';
import { acceptsSipHost, getSipUser, matchRoute, stripSipUri } from './routing';

export class CallNotFoundError extends Error {}
export class InvalidCallStateError extends Error {}

export interface SipAuthCredentials {
    username: string;
    password: string;
}

export interface OutboundSipCallParams {
    requestUri: string;
    sdp: string;
    headers?: SipHeaders;
    receiverUrl?: string;
    controlConnectionId?: string;
    callingNumber?: string;
    callingName?: string;
    proxy?: string;
    auth?: SipAuthCredentials;
    outboundAttemptId?: string;
}

export interface OutboundSipCallResult {
    sessionId: string;
    sipCallId: string;
    sdp: string;
}

interface PendingOutboundSipCall {
    controlConnectionId?: string;
    cancelRequested: boolean;
    cancelError?: NativeOperationError;
    attempt?: OutboundAttempt;
    completed: Promise<void>;
    finish: () => void;
}

export class SipGateway {
    private logger = BaseLogger.child({ ns: 'SipGateway' });
    private signaling: SipbridgeSignaling;
    private pendingOutboundCalls = new Map<string, PendingOutboundSipCall>();
    private pendingInboundCalls = new Map<string, SipResponse>();
    constructor(
        private config: GatewayConfig,
        private registry: CallRegistry,
        private httpClient: GatewayHttpClient,
        signaling?: SipbridgeSignaling,
        private controlHub?: ControlHub,
        private lifecycle?: GatewayLifecycle,
        mediaReady: () => boolean = () => true
    ) {
        this.signaling = signaling ?? new SipbridgeSignaling(config);
        this.signaling.applicationReady = () =>
            (!config.ROUTES_REQUIRED || config.ROUTES.length + (controlHub?.routeCount ?? 0) > 0) && (!config.RTPBRIDGE_REQUIRED || mediaReady());
        this.signaling.isDraining = () => lifecycle?.isDraining ?? false;
    }
    get isConnected() {
        return this.signaling.isConnected;
    }
    async start() {
        this.signaling.onInvite = async (req, res) => {
            try {
                await this.handleInvite(req, res);
            } catch {
                if (!res.finalResponseSent) await res.respond(500).catch(() => undefined);
            }
        };
        await this.signaling.start();
    }
    async handleInvite(req: IncomingSipRequest, res: SipResponse) {
        if (this.lifecycle?.isDraining) {
            await res.respond(503, { headers: { 'Retry-After': '1' } });
            return;
        }
        if (this.lifecycle) return this.lifecycle.track(() => this.handleAdmittedInvite(req, res));
        return this.handleAdmittedInvite(req, res);
    }

    private async handleAdmittedInvite(req: IncomingSipRequest, res: SipResponse) {
        const destinationUri = stripSipUri(req.uri);
        if (!acceptsSipHost(destinationUri, this.config.SIP_ALLOWED_DOMAINS)) {
            await res.respond(404);
            return;
        }
        const destinationUser = getSipUser(destinationUri);
        const routeDestination = { destinationUri, destinationUser };
        const controlRoute = this.controlHub?.findRoute(routeDestination);
        const httpRoute = matchRoute(this.config.ROUTES, routeDestination);

        if (!controlRoute && !httpRoute) {
            this.logger.info({ destinationUri, destinationUser }, 'No route for INVITE');
            await res.respond(404);
            return;
        }

        const sipCallId = req.callId || readHeader(req, 'call-id') || '';
        const callId = this.registry.reserveCallId(sipCallId);
        const inviteRequest = buildInviteRequest(req, callId, sipCallId, destinationUri, destinationUser);
        const routeUrl = controlRoute?.route.url ?? httpRoute!.url;

        let acceptedReceiverUrl: string | undefined;
        let answeredDialog: NativeDialog | undefined;
        this.pendingInboundCalls.set(callId, res);
        try {
            const action = controlRoute
                ? await this.requestInviteActionFromControl(controlRoute.connectionId, inviteRequest)
                : await this.requestInviteActionFromHttp(httpRoute!.url, inviteRequest);
            this.lifecycle?.assertRunning();

            if (action.action === 'reject') {
                this.logger.info({ callId, status: action.status }, 'Backend rejected INVITE');
                await res.respond(action.status, { headers: action.headers });
                this.registry.releaseReservation(callId);
                return;
            }

            acceptedReceiverUrl = controlRoute ? controlRoute.route.url : (action.receiverUrl ?? httpRoute!.url);

            const dialog = await res.answer(action.sdp, action.headers);
            answeredDialog = dialog;
            this.lifecycle?.assertRunning();
            const now = new Date().toISOString();
            const call = this.registry.activate({
                callId,
                sipCallId,
                routeUrl,
                receiverUrl: controlRoute ? controlRoute.route.url : (action.receiverUrl ?? httpRoute!.url),
                controlConnectionId: controlRoute?.connectionId,
                destinationUri,
                destinationUser,
                sourceUri: inviteRequest.sourceUri,
                localSdp: action.sdp,
                remoteSdp: req.body,
                createdAt: now,
                updatedAt: now,
                dialog
            });

            this.bindDialog(call);
            answeredDialog = undefined;
            this.logger.info({ call: sipCallLogContext(call) }, 'SIP dialog answered');
            void this.sendFollowUpEvent(call, {
                event: 'answered',
                callId,
                sipCallId,
                sdp: action.sdp,
                status: action.status ?? 200,
                headers: action.headers,
                receivedAt: new Date().toISOString()
            });
        } catch (err) {
            this.registry.remove(callId);
            this.registry.releaseReservation(callId);
            if (answeredDialog) await this.destroyFailedInviteDialog(answeredDialog, callId);
            this.logger.warn({ failure: 'signaling-or-owner-operation-failed', callId, routeUrl }, 'Failed to route INVITE');
            if (acceptedReceiverUrl) {
                void this.sendFailedInviteEvent(controlRoute?.connectionId, acceptedReceiverUrl, {
                    event: 'terminated',
                    callId,
                    sipCallId,
                    reason: 'answer-failed',
                    receivedAt: new Date().toISOString()
                });
            }
            if (!res.finalResponseSent) {
                const status = sipStatusForError(err);
                await res.respond(status);
            }
        } finally {
            this.pendingInboundCalls.delete(callId);
        }
    }

    private async destroyFailedInviteDialog(dialog: NativeDialog, callId: string) {
        try {
            await dialog.bye();
        } catch (err) {
            this.logger.warn({ failure: 'signaling-or-owner-operation-failed', callId }, 'Failed to destroy SIP dialog after INVITE setup failure');
        }
    }

    async reinvite(callId: string, sdp: string, headers?: SipHeaders) {
        const call = this.registry.get(callId);
        if (!call) throw new CallNotFoundError(`Call ${callId} not found`);

        try {
            const remoteSdp = await call.dialog.reinvite(sdp, headers);
            this.registry.updateSdp(callId, { localSdp: sdp, remoteSdp });
            return { sdp: remoteSdp };
        } catch (err) {
            if (err instanceof NativeOperationError && (err.uncertain || err.unavailable)) throw err;
            throw new InvalidCallStateError(errorMessage(err));
        }
    }

    async createOutbound(params: OutboundSipCallParams): Promise<OutboundSipCallResult> {
        this.lifecycle?.assertAccepting();
        if (this.lifecycle) return this.lifecycle.track(() => this.createAdmittedOutbound(params));
        return this.createAdmittedOutbound(params);
    }

    private async createAdmittedOutbound(params: OutboundSipCallParams): Promise<OutboundSipCallResult> {
        const receiverUrl = params.controlConnectionId ? controlUrl(params.controlConnectionId) : params.receiverUrl;
        if (!receiverUrl) throw new InvalidCallStateError('receiverUrl is required for outbound SIP calls without a control connection');

        const outboundAttemptId = params.outboundAttemptId ?? randomUUID();
        const pending = this.registerPendingOutboundCall(outboundAttemptId, params.controlConnectionId);

        const logContext = outboundSipLogContext(params);
        this.logger.info(logContext, 'Creating outbound SIP dialog');
        try {
            pending.attempt = this.signaling.openDialog(params);
            if (pending.cancelRequested) await pending.attempt.cancel();
            const dialog = await pending.attempt.completed;

            if (pending.cancelRequested || dialog.isEnded || this.lifecycle?.isStopping) {
                await destroyDialog(dialog);
                throw new InvalidCallStateError('Outbound SIP call was cancelled');
            }

            const sipCallId = dialog.sipCallId;
            const callId = this.registry.reserveCallId(sipCallId);
            const now = new Date().toISOString();
            const destinationUri = stripSipUri(params.requestUri);
            const call = this.registry.activate({
                callId,
                sipCallId,
                routeUrl: receiverUrl,
                receiverUrl,
                controlConnectionId: params.controlConnectionId,
                destinationUri,
                destinationUser: getSipUser(destinationUri),
                sourceUri: getSourceUri(params.headers),
                localSdp: dialog.localSdp || params.sdp,
                remoteSdp: dialog.remoteSdp,
                createdAt: now,
                updatedAt: now,
                dialog
            });

            this.bindDialog(call);
            this.logger.info({ call: sipCallLogContext(call) }, 'Outbound SIP dialog answered');
            return { sessionId: callId, sipCallId, sdp: dialog.remoteSdp };
        } catch (err) {
            if (pending.cancelRequested) this.logger.info(logContext, 'Outbound SIP dialog cancelled');
            else this.logger.warn({ failure: 'signaling-or-owner-operation-failed', ...logContext }, 'Outbound SIP dialog failed');
            if (err instanceof NativeOperationError && (err.uncertain || err.unavailable)) throw err;
            throw new InvalidCallStateError(errorMessage(err));
        } finally {
            pending.finish();
            if (this.pendingOutboundCalls.get(outboundAttemptId) === pending) {
                this.pendingOutboundCalls.delete(outboundAttemptId);
            }
        }
    }

    async cancelOutbound(outboundAttemptId: string, controlConnectionId?: string) {
        const pending = this.pendingOutboundCalls.get(outboundAttemptId);
        if (!pending) throw new CallNotFoundError(`Outbound SIP attempt ${outboundAttemptId} not found`);
        if (pending.controlConnectionId !== controlConnectionId) {
            throw new InvalidCallStateError('Outbound SIP attempt belongs to another control connection');
        }
        if (pending.cancelRequested) {
            if (pending.cancelError) throw pending.cancelError;
            return { ok: true as const };
        }

        pending.cancelRequested = true;
        if (pending.attempt) {
            await pending.attempt.cancel().catch(err => {
                this.logger.warn(
                    {
                        failure: 'signaling-or-owner-operation-failed',
                        outboundAttemptId,
                        controlConnectionId
                    },
                    'Failed to send outbound SIP CANCEL'
                );
                pending.cancelError = err instanceof NativeOperationError ? err : new NativeOperationError('Native CANCEL outcome unknown', true);
                throw pending.cancelError;
            });
        }
        this.logger.info({ outboundAttemptId, controlConnectionId }, 'Cancelled pending outbound SIP dialog');
        return { ok: true as const };
    }

    async shutdown() {
        for (const [callId, res] of this.pendingInboundCalls) {
            if (!res.finalResponseSent) await res.respond(503, { headers: { 'Retry-After': '1' } }).catch(() => undefined);
            this.registry.releaseReservation(callId);
        }
        await Promise.allSettled([
            ...[...this.pendingOutboundCalls.entries()].map(async ([id, pending]) => {
                await this.cancelOutbound(id, pending.controlConnectionId);
                await pending.completed;
            }),
            ...this.registry.list().map(call => this.bye(call.callId, 'gateway-shutdown'))
        ]);
        await this.signaling.stop();
    }

    async bye(callId: string, reason?: string, headers?: SipHeaders) {
        const call = this.registry.get(callId);
        if (!call) throw new CallNotFoundError(`Call ${callId} not found`);

        const byeHeaders = { ...(headers ?? {}) };

        await call.dialog.bye(byeHeaders).catch(err => {
            if (err instanceof NativeOperationError && (err.uncertain || err.unavailable)) throw err;
            throw new InvalidCallStateError(errorMessage(err));
        });

        const removed = this.registry.remove(callId);
        if (removed) {
            void this.sendFollowUpEvent(removed, {
                event: 'terminated',
                callId,
                sipCallId: removed.sipCallId,
                reason,
                headers: byeHeaders,
                receivedAt: new Date().toISOString()
            });
        }
    }

    async terminateCallsForControlConnection(connectionId: string) {
        const pendingCancellations = [...this.pendingOutboundCalls.entries()]
            .filter(([, pending]) => pending.controlConnectionId === connectionId)
            .map(([outboundAttemptId]) => this.cancelOutbound(outboundAttemptId, connectionId));
        const calls = this.registry
            .list()
            .filter(call => call.controlConnectionId === connectionId)
            .map(call => this.registry.remove(call.callId))
            .filter((call): call is ActiveCall => !!call);
        await Promise.allSettled([
            ...pendingCancellations,
            ...calls.map(async call => {
                try {
                    await call.dialog.bye();
                    void this.sendFollowUpEvent(call, {
                        event: 'terminated',
                        callId: call.callId,
                        sipCallId: call.sipCallId,
                        reason: 'control-disconnected',
                        headers: {},
                        receivedAt: new Date().toISOString()
                    });
                } catch (err) {
                    this.logger.warn(
                        { failure: 'signaling-or-owner-operation-failed', callId: call.callId, connectionId },
                        'Failed to terminate control-owned SIP call'
                    );
                }
            })
        ]);
    }

    private bindDialog(call: ActiveCall) {
        call.dialog.on('request', (req, res) => {
            this.handleRemoteModify(call.callId, req, res).catch(err => {
                this.logger.error({ failure: 'signaling-or-owner-operation-failed', callId: call.callId }, 'Unhandled remote re-INVITE error');
                if (!res.finalResponseSent) void res.respond(500).catch(() => undefined);
            });
        });

        call.dialog.on('ended', reason => {
            const removed = this.registry.remove(call.callId);
            if (!removed) return;

            const event = reason === 'bye' ? 'bye' : 'terminated';
            void this.sendFollowUpEvent(removed, {
                event,
                callId: removed.callId,
                sipCallId: removed.sipCallId,

                receivedAt: new Date().toISOString()
            });
        });
        call.dialog.activate();
    }

    private async handleRemoteModify(callId: string, req: IncomingSipRequest, res: SipResponse) {
        const call = this.registry.get(callId);
        if (!call) {
            await res.respond(481);
            return;
        }

        try {
            const action = await this.sendFollowUpEvent(
                call,
                {
                    event: 'reinvite',
                    callId,
                    sipCallId: call.sipCallId,
                    headers: readHeaders(req),
                    sdp: req.body,
                    receivedAt: new Date().toISOString()
                },
                true
            );

            if (action.action === 'reject') {
                await res.respond(action.status, { headers: action.headers });
                return;
            }

            await res.respond(action.status ?? 200, { body: action.sdp, headers: action.headers });
            this.registry.updateSdp(callId, { localSdp: action.sdp, remoteSdp: req.body });
        } catch (err) {
            this.logger.warn({ failure: 'signaling-or-owner-operation-failed', callId }, 'Receiver failed to handle remote re-INVITE');
            await res.respond(sipStatusForError(err));
        }
    }

    private sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction: true): Promise<SipAction>;
    private sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: false): Promise<void>;
    private async sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: boolean): Promise<SipAction | void> {
        if (this.lifecycle && !this.lifecycle.isStopping) {
            return this.lifecycle.track(() => this.deliverFollowUpEvent(call, event, expectAction));
        }
        return this.deliverFollowUpEvent(call, event, expectAction);
    }

    private async deliverFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: boolean): Promise<SipAction | void> {
        if (call.controlConnectionId && this.controlHub?.isConnected(call.controlConnectionId)) {
            if (expectAction) {
                try {
                    const response = await this.controlHub.request(
                        call.controlConnectionId,
                        event.event === 'reinvite' ? 'sip.reinvite' : `sip.${event.event}`,
                        event,
                        this.config.EVENT_HTTP_TIMEOUT_MS
                    );
                    return parseSipActionResponse(response, { allowReceiverUrl: false });
                } catch (err) {
                    if (err instanceof ControlConnectionUnavailableError) {
                        throw new HttpPostError('Control request failed', { cause: err, code: 'ECONNABORTED' });
                    }
                    throw err;
                }
            }

            const sent = this.controlHub.sendEvent(call.controlConnectionId, {
                event: `sip.${event.event}`,
                sessionId: call.callId,
                data: event
            });
            if (!sent) {
                this.logger.warn({ callId: call.callId, event: event.event }, 'Failed to deliver control follow-up event');
            }
            return;
        }

        if (isControlUrl(call.receiverUrl)) {
            const err = new ControlConnectionUnavailableError(`Control connection for call ${call.callId} is not available`);
            if (expectAction) {
                throw new HttpPostError('Control request failed', { cause: err, code: 'ECONNABORTED' });
            }
            this.logger.warn(
                { failure: 'signaling-or-owner-operation-failed', callId: call.callId, event: event.event },
                'Dropping control-owned follow-up event'
            );
            return;
        }

        if (expectAction) {
            const response = await this.httpClient.postJson<unknown>(call.receiverUrl, event, this.config.EVENT_HTTP_TIMEOUT_MS);
            return parseSipActionResponse(response, { allowReceiverUrl: false });
        }

        try {
            await this.httpClient.postJson<unknown>(call.receiverUrl, event, this.config.EVENT_HTTP_TIMEOUT_MS);
        } catch (err) {
            this.logger.warn(
                { failure: 'signaling-or-owner-operation-failed', callId: call.callId, event: event.event },
                'Failed to deliver follow-up event'
            );
        }
    }

    private async requestInviteActionFromControl(connectionId: string, inviteRequest: InviteHttpRequest) {
        this.logger.info({ callId: inviteRequest.callId, connectionId }, 'Routing INVITE to control connection');
        try {
            const response = await this.controlHub!.request(connectionId, 'sip.invite', inviteRequest, this.config.INVITE_HTTP_TIMEOUT_MS);
            return parseSipActionResponse(response, { allowReceiverUrl: false });
        } catch (err) {
            if (err instanceof ControlConnectionUnavailableError) {
                throw new HttpPostError('Control request failed', { cause: err, code: 'ECONNABORTED' });
            }
            throw err;
        }
    }

    private async requestInviteActionFromHttp(routeUrl: string, inviteRequest: InviteHttpRequest) {
        this.logger.info({ callId: inviteRequest.callId, destinationUri: inviteRequest.destinationUri, routeUrl }, 'Routing INVITE to HTTP');
        const response = await this.httpClient.postJson<unknown>(routeUrl, inviteRequest, this.config.INVITE_HTTP_TIMEOUT_MS);
        return parseSipActionResponse(response, { allowReceiverUrl: true });
    }

    private async sendFailedInviteEvent(connectionId: string | undefined, receiverUrl: string, event: FollowUpHttpEvent) {
        if (this.lifecycle && !this.lifecycle.isStopping) {
            return this.lifecycle.track(() => this.deliverFailedInviteEvent(connectionId, receiverUrl, event));
        }
        return this.deliverFailedInviteEvent(connectionId, receiverUrl, event);
    }

    private async deliverFailedInviteEvent(connectionId: string | undefined, receiverUrl: string, event: FollowUpHttpEvent) {
        if (connectionId && this.controlHub?.isConnected(connectionId)) {
            this.controlHub.sendEvent(connectionId, {
                event: 'sip.terminated',
                sessionId: event.callId,
                data: event
            });
            return;
        }
        if (isControlUrl(receiverUrl)) return;

        try {
            await this.httpClient.postJson(receiverUrl, event, this.config.EVENT_HTTP_TIMEOUT_MS);
        } catch (err) {
            this.logger.warn(
                { failure: 'signaling-or-owner-operation-failed', callId: event.callId },
                'Failed to deliver failed INVITE termination event'
            );
        }
    }

    private registerPendingOutboundCall(outboundAttemptId: string, controlConnectionId?: string) {
        if (this.pendingOutboundCalls.has(outboundAttemptId)) {
            throw new InvalidCallStateError(`Outbound SIP attempt ${outboundAttemptId} already exists`);
        }
        const completion = Promise.withResolvers<void>();
        const pending: PendingOutboundSipCall = {
            controlConnectionId,
            cancelRequested: false,
            completed: completion.promise,
            finish: completion.resolve
        };
        this.pendingOutboundCalls.set(outboundAttemptId, pending);
        return pending;
    }
}

async function destroyDialog(dialog: NativeDialog) {
    await dialog.bye();
}

function outboundSipLogContext(params: OutboundSipCallParams) {
    const destinationUri = stripSipUri(params.requestUri);
    const withoutScheme = destinationUri.replace(/^sips?:/i, '');
    const atIndex = withoutScheme.lastIndexOf('@');
    const destinationHost = atIndex === -1 ? undefined : withoutScheme.slice(atIndex + 1);
    const destinationUser = getSipUser(destinationUri);
    return {
        destinationHost,
        destinationUserSuffix: destinationUser?.slice(-4),
        transport: /;transport=([^;?]+)/i.exec(params.requestUri)?.[1],
        authConfigured: !!params.auth,
        controlConnectionId: params.controlConnectionId
    };
}

function sipCallLogContext(call: ActiveCall) {
    return {
        callId: call.callId,
        sipCallId: call.sipCallId,
        controlConnectionId: call.controlConnectionId,
        createdAt: call.createdAt,
        destinationUserSuffix: call.destinationUser?.slice(-4),
        sourceUserSuffix: call.sourceUri ? getSipUser(call.sourceUri)?.slice(-4) : undefined,
        hasLocalSdp: !!call.localSdp,
        hasRemoteSdp: !!call.remoteSdp
    };
}

function buildInviteRequest(
    req: IncomingSipRequest,
    callId: string,
    sipCallId: string,
    destinationUri: string,
    destinationUser?: string
): InviteHttpRequest {
    const from = readHeader(req, 'from');
    const to = readHeader(req, 'to');
    const contact = readHeader(req, 'contact');

    return {
        event: 'invite',
        callId,
        sipCallId,
        destinationUri,
        destinationUser,
        sourceUri: from ? stripSipUri(from) : undefined,
        from,
        to,
        contact,
        headers: readHeaders(req),
        sdp: req.body,
        receivedAt: new Date().toISOString()
    };
}

function readHeaders(req: IncomingSipRequest) {
    const headers: SipHeaders = {};
    for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (typeof value === 'string') headers[key] = value;
    }
    return headers;
}

function readHeader(req: Pick<IncomingSipRequest, 'get' | 'headers'>, name: string) {
    try {
        return req.get(name) || req.headers?.[name.toLowerCase()];
    } catch {
        return req.headers?.[name.toLowerCase()];
    }
}

function sipStatusForError(err: unknown) {
    if (err instanceof GatewayDrainingError) return 503;
    if (err instanceof HttpPostError && err.code === 'ECONNABORTED') return 504;
    if (err instanceof InvalidHttpActionError) return 502;
    return 502;
}

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err);
}

function isControlUrl(url: string) {
    return url.startsWith('control://');
}

function controlUrl(connectionId: string) {
    return `control://${connectionId}`;
}

function getSourceUri(headers?: SipHeaders) {
    const from = headers?.From ?? headers?.from;
    return from ? stripSipUri(from) : undefined;
}
