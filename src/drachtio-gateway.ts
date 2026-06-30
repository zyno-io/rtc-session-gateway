import Srf = require('drachtio-srf');

import type { ActiveCall } from './call-registry';
import { CallRegistry, snapshotCall } from './call-registry';
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
import { getSipUser, matchRoute, stripSipUri } from './routing';

export class CallNotFoundError extends Error { }
export class InvalidCallStateError extends Error { }

export interface OutboundSipCallParams {
    requestUri: string;
    sdp: string;
    headers?: SipHeaders;
    receiverUrl?: string;
    controlConnectionId?: string;
    callingNumber?: string;
    callingName?: string;
    proxy?: string;
}

export interface OutboundSipCallResult {
    sessionId: string;
    sipCallId: string;
    sdp: string;
}

export class DrachtioGateway {
    private logger = BaseLogger.child({ ns: 'DrachtioGateway' });
    private srf: Srf;
    private connected = false;

    constructor(
        private config: GatewayConfig,
        private registry: CallRegistry,
        private httpClient: GatewayHttpClient,
        srf?: Srf,
        private controlHub?: ControlHub
    ) {
        this.srf = srf ?? new Srf();
    }

    get isConnected() {
        return this.connected;
    }

    async start() {
        this.srf.on('connect', (_err, hostPort) => {
            this.connected = true;
            this.logger.info({ hostPort }, 'Connected to drachtio-server');
        });
        this.srf.on('disconnect', () => {
            this.connected = false;
            this.logger.warn('Disconnected from drachtio-server');
        });
        this.srf.on('error', err => {
            this.logger.error({ err }, 'Drachtio error');
        });
        this.srf.invite((req, res) => {
            this.handleInvite(req, res).catch(err => {
                this.logger.error({ err }, 'Unhandled INVITE error');
                if (!res.finalResponseSent) res.send(500, 'Internal Server Error', {});
            });
        });

        await this.srf.connect({
            host: this.config.DRACHTIO_HOST,
            port: this.config.DRACHTIO_PORT,
            secret: this.config.DRACHTIO_SECRET
        });
    }

    async handleInvite(req: Srf.SrfRequest, res: Srf.SrfResponse) {
        const destinationUri = stripSipUri(req.uri);
        const destinationUser = getSipUser(destinationUri);
        const routeDestination = { destinationUri, destinationUser };
        const controlRoute = this.controlHub?.findRoute(routeDestination);
        const httpRoute = matchRoute(this.config.ROUTES, routeDestination);

        if (!controlRoute && !httpRoute) {
            this.logger.info({ destinationUri, destinationUser }, 'No route for INVITE');
            res.send(404, 'No Route', {});
            return;
        }

        const sipCallId = req.callId || readHeader(req, 'call-id') || '';
        const callId = this.registry.reserveCallId(sipCallId);
        const inviteRequest = buildInviteRequest(req, callId, sipCallId, destinationUri, destinationUser);
        const routeUrl = controlRoute?.route.url ?? httpRoute!.url;

        try {
            const action = controlRoute
                ? await this.requestInviteActionFromControl(controlRoute.connectionId, inviteRequest)
                : await this.requestInviteActionFromHttp(httpRoute!.url, inviteRequest);

            if (action.action === 'reject') {
                this.logger.info({ callId, status: action.status }, 'Backend rejected INVITE');
                res.send(action.status, action.reason ?? 'Rejected', { headers: action.headers });
                this.registry.releaseReservation(callId);
                return;
            }

            const dialog = await this.srf.createUAS(req, res, {
                localSdp: action.sdp,
                headers: action.headers
            });
            const now = new Date().toISOString();
            const call = this.registry.activate({
                callId,
                sipCallId,
                routeUrl,
                receiverUrl: controlRoute ? controlRoute.route.url : action.receiverUrl ?? httpRoute!.url,
                controlConnectionId: controlRoute?.connectionId,
                destinationUri,
                destinationUser,
                sourceUri: inviteRequest.sourceUri,
                localSdp: action.sdp,
                remoteSdp: req.body || req.sdp,
                createdAt: now,
                updatedAt: now,
                dialog
            });

            this.bindDialog(call);
            this.logger.info({ call: snapshotCall(call) }, 'SIP dialog answered');
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
            this.registry.releaseReservation(callId);
            this.logger.warn({ err, callId, routeUrl }, 'Failed to route INVITE');
            if (!res.finalResponseSent) {
                const status = sipStatusForError(err);
                res.send(status, status === 504 ? 'Gateway Timeout' : 'Bad Gateway', {});
            }
        }
    }

    async reinvite(callId: string, sdp: string, headers?: SipHeaders) {
        const call = this.registry.get(callId);
        if (!call) throw new CallNotFoundError(`Call ${callId} not found`);

        try {
            const remoteSdp = await call.dialog.modify(sdp, { headers } as any);
            this.registry.updateSdp(callId, { localSdp: sdp, remoteSdp });
            return { sdp: remoteSdp };
        } catch (err) {
            throw new InvalidCallStateError(errorMessage(err));
        }
    }

    async createOutbound(params: OutboundSipCallParams): Promise<OutboundSipCallResult> {
        const receiverUrl = params.controlConnectionId ? controlUrl(params.controlConnectionId) : params.receiverUrl;
        if (!receiverUrl) throw new InvalidCallStateError('receiverUrl is required for outbound SIP calls without a control connection');

        try {
            const dialog = await this.srf.createUAC(params.requestUri, {
                localSdp: params.sdp,
                headers: params.headers,
                callingNumber: params.callingNumber,
                callingName: params.callingName,
                proxy: params.proxy
            } as Srf.CreateUACOptions & { callingNumber?: string; callingName?: string });

            const sipCallId = dialog.sip.callId;
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
                localSdp: dialog.local.sdp || params.sdp,
                remoteSdp: dialog.remote.sdp,
                createdAt: now,
                updatedAt: now,
                dialog
            });

            this.bindDialog(call);
            this.logger.info({ call: snapshotCall(call) }, 'Outbound SIP dialog answered');
            return { sessionId: callId, sipCallId, sdp: dialog.remote.sdp };
        } catch (err) {
            throw new InvalidCallStateError(errorMessage(err));
        }
    }

    async bye(callId: string, reason?: string, headers?: SipHeaders) {
        const call = this.registry.get(callId);
        if (!call) throw new CallNotFoundError(`Call ${callId} not found`);

        const byeHeaders = { ...(headers ?? {}) };
        if (reason && !byeHeaders.Reason) byeHeaders.Reason = reason;

        await new Promise<void>((resolve, reject) => {
            call.dialog.destroy({ headers: byeHeaders }, err => (err ? reject(err) : resolve()));
        }).catch(err => {
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

    private bindDialog(call: ActiveCall) {
        call.dialog.on('modify', (req, res) => {
            this.handleRemoteModify(call.callId, req, res).catch(err => {
                this.logger.error({ err, callId: call.callId }, 'Unhandled remote re-INVITE error');
                if (!res.finalResponseSent) res.send(500, 'Internal Server Error', {});
            });
        });

        call.dialog.on('destroy', msg => {
            const removed = this.registry.remove(call.callId);
            if (!removed) return;

            const event = msg?.method === 'BYE' ? 'bye' : 'terminated';
            void this.sendFollowUpEvent(removed, {
                event,
                callId: removed.callId,
                sipCallId: removed.sipCallId,
                headers: msg ? readHeaders(msg) : undefined,
                receivedAt: new Date().toISOString()
            });
        });
    }

    private async handleRemoteModify(callId: string, req: Srf.SrfRequest, res: Srf.SrfResponse) {
        const call = this.registry.get(callId);
        if (!call) {
            res.send(481, 'Call Does Not Exist', {});
            return;
        }

        try {
            const action = await this.sendFollowUpEvent(call, {
                event: 'reinvite',
                callId,
                sipCallId: call.sipCallId,
                headers: readHeaders(req),
                sdp: req.body || req.sdp,
                receivedAt: new Date().toISOString()
            }, true);

            if (action.action === 'reject') {
                res.send(action.status, action.reason ?? 'Rejected', { headers: action.headers });
                return;
            }

            res.send(action.status ?? 200, { body: action.sdp, headers: action.headers });
            this.registry.updateSdp(callId, { localSdp: action.sdp, remoteSdp: req.body || req.sdp });
        } catch (err) {
            this.logger.warn({ err, callId }, 'Receiver failed to handle remote re-INVITE');
            res.send(sipStatusForError(err), 'Bad Gateway', {});
        }
    }

    private sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction: true): Promise<SipAction>;
    private sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: false): Promise<void>;
    private async sendFollowUpEvent(
        call: ActiveCall,
        event: FollowUpHttpEvent,
        expectAction?: boolean
    ): Promise<SipAction | void> {
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
            this.logger.warn({ err, callId: call.callId, event: event.event }, 'Dropping control-owned follow-up event');
            return;
        }

        if (expectAction) {
            const response = await this.httpClient.postJson<unknown>(
                call.receiverUrl,
                event,
                this.config.EVENT_HTTP_TIMEOUT_MS
            );
            return parseSipActionResponse(response, { allowReceiverUrl: false });
        }

        try {
            await this.httpClient.postJson<unknown>(call.receiverUrl, event, this.config.EVENT_HTTP_TIMEOUT_MS);
        } catch (err) {
            this.logger.warn({ err, callId: call.callId, event: event.event }, 'Failed to deliver follow-up event');
        }
    }

    private async requestInviteActionFromControl(connectionId: string, inviteRequest: InviteHttpRequest) {
        this.logger.info({ callId: inviteRequest.callId, connectionId }, 'Routing INVITE to control connection');
        try {
            const response = await this.controlHub!.request(
                connectionId,
                'sip.invite',
                inviteRequest,
                this.config.INVITE_HTTP_TIMEOUT_MS
            );
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
        const response = await this.httpClient.postJson<unknown>(
            routeUrl,
            inviteRequest,
            this.config.INVITE_HTTP_TIMEOUT_MS
        );
        return parseSipActionResponse(response, { allowReceiverUrl: true });
    }
}

function buildInviteRequest(
    req: Srf.SrfRequest,
    callId: string,
    sipCallId: string,
    destinationUri: string,
    destinationUser?: string
): InviteHttpRequest {
    const from = readHeader(req, 'from') || req.from;
    const to = readHeader(req, 'to') || req.to;
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
        sdp: req.body || req.sdp,
        receivedAt: new Date().toISOString()
    };
}

function readHeaders(req: Srf.SrfRequest) {
    const headers: SipHeaders = {};
    for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (typeof value === 'string') headers[key] = value;
    }
    return headers;
}

function readHeader(req: Pick<Srf.SrfRequest, 'get' | 'headers'>, name: string) {
    try {
        return req.get(name) || req.headers?.[name.toLowerCase()];
    } catch {
        return req.headers?.[name.toLowerCase()];
    }
}

function sipStatusForError(err: unknown) {
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
