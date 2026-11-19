import {
    NativeOperationError,
    dialogRequestHeaders,
    messageCarriesSdp,
    SipbridgeSignaling,
    type IncomingSipRequest,
    type NativeDialog,
    type OutboundAttempt,
    type SipResponse,
    type SipSource
} from './sipbridge-signaling';
import type { SipMessage } from './sipbridge/generated/sipbridge-control';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
    isValidTransferId,
    TRANSFER_ID_ERROR,
    parseSipActionResponse
} from './http-contract';
import { type GatewayHttpClient, HttpPostError } from './http-client';
import { BaseLogger } from './logger';
import { GatewayDrainingError, GatewayLifecycle } from './gateway-lifecycle';
import type { SipFirewall } from './sip-firewall';
import type { GatewayMediaController } from './media-controller';
import type { SipTransferParams, SipTransferStatus } from './sip-handoff-contract';
import {
    assertDirectMediaAnswer,
    assertRollbackAnswer,
    parseReferTarget,
    parseReplaces,
    rejectSdpOffer,
    relaySdp,
    preservesMediaParameters,
    sharesMediaEndpoint,
    usesHostnameMedia
} from './sip-sdp';
import { sourceIp } from './firewall-address';
import { acceptsSipHost, getSipUser, matchRoute, stripSipUri } from './routing';

export class CallNotFoundError extends Error {}
export class InvalidCallStateError extends Error {}
/** A request that conflicts with an operation already in progress on the same call. */
export class SipOperationConflictError extends InvalidCallStateError {}

const HANDOFF_ACK_TIMEOUT_MS = 10_000;
/**
 * Backoff before each retry of an ACK or BYE that sipbridge definitely did not accept (bounded at 7 retries, about 48 s).
 * The tail outlasts sipbridge's 40 s command budget, after which the slots held by hung commands are free again.
 */
const TERMINAL_RETRY_DELAYS_MS = [250, 1000, 2000, 5000, 10_000, 15_000, 15_000];
/** Bounded retry of a rollback re-INVITE refused while sipbridge's automatic ACK (or a peer INVITE) is still pending; 2.85 s total, above sipbridge's 2 s ACK write budget. */
const RESTORE_RETRY_DELAYS_MS = [100, 250, 500, 1000, 1000];
/** RFC 3261 13.3.1.4: a UAS gives up waiting for the ACK after 64*T1 (32 s); the dialog is confirmed regardless. */
const ACK_GIVE_UP_MS = 32_000;
/** Finished transfers remembered per call for transferId idempotency. */
const FINISHED_TRANSFER_LIMIT = 16;
/** Every transfer ID ever admitted on a call is remembered (so an evicted result can never be dialed again), up to this many. */
const ADMITTED_TRANSFER_LIMIT = 256;
const SDP_HEADERS = { 'Content-Type': 'application/sdp' };

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
    /** The destination's answer was observed: native CANCEL no longer applies, the ACK-aware cleanup owns the dialog. */
    answered?: boolean;
    completed: Promise<void>;
    finish: () => void;
}

export class SipGateway {
    private logger = BaseLogger.child({ ns: 'SipGateway' });
    private signaling: SipbridgeSignaling;
    private pendingOutboundCalls = new Map<string, PendingOutboundSipCall>();
    private pendingInboundCalls = new Map<string, SipResponse>();
    /** Keyed by ActiveCall instance, never callId: a later call may reuse the callId while an earlier call's cleanup is pending. */
    private transfers = new WeakMap<ActiveCall, { id: string; promise: Promise<SipTransferStatus> }>();
    private transferRequests = new WeakMap<ActiveCall, PendingOutboundSipCall>();
    /** Calls with a cross-leg SDP operation in flight; at most one per call (I2). Keyed by instance: a reused callId is a different call. */
    private modifyingPairs = new Set<ActiveCall>();
    /** Pairs whose lock outlives the REFER handler: held until a detached final NOTIFY settles. */
    private retainedPairLocks = new Set<ActiveCall>();
    /** Local media of calls under transfer, reserved from admission through teardown: no other call may bind to it. */
    private mediaReservations = new Map<ActiveCall, string>();
    /**
     * Local media a SIP answer or offer in flight will bind (inbound answer, remote or app re-INVITE, outbound INVITE, REFER
     * return): not yet on the call, but already claimed. A call may hold several claims; `owner` is unset before it exists.
     */
    private pendingLocalMedia = new Set<{ owner?: ActiveCall; sdp: string }>();
    /** Last SDP this gateway sent on each leg; keeps origin versions monotonic when relaying between legs. */
    private sentSdp = new WeakMap<NativeDialog, string>();
    /** Legs holding an answered late-offer 2xx the gateway has not yet ACKed; the settle function sends the rejection ACK (I6). */
    private ackOwed = new WeakMap<NativeDialog, { settle: () => Promise<void>; answeredAt: () => number }>();
    /** Pending deferred BYEs for legs whose owed ACK was refused; cleared on shutdown or when the leg ends. */
    private deferredByes = new Set<NodeJS.Timeout>();
    /** Retry backoff sleeps in progress; shutdown wakes them so no retry or timer outlives it. */
    private retrySleeps = new Set<{ timer: NodeJS.Timeout; wake: () => void }>();
    /** Set when shutdown starts; no BYE retry or deferral is scheduled afterwards. */
    private stopping = false;
    private readonly media?: GatewayMediaController;
    private readonly handoffAckTimeoutMs: number;
    private readonly terminalRetryDelaysMs: number[];
    private readonly restoreRetryDelaysMs: number[];
    private readonly glareDelayMs: (originated: boolean) => number;
    private readonly ackGiveUpMs: number;
    constructor(
        private config: GatewayConfig,
        private registry: CallRegistry,
        private httpClient: GatewayHttpClient,
        signaling?: SipbridgeSignaling,
        private controlHub?: ControlHub,
        private lifecycle?: GatewayLifecycle,
        options: {
            media?: () => boolean;
            firewall?: SipFirewall;
            mediaController?: GatewayMediaController;
            handoffAckTimeoutMs?: number;
            terminalRetryDelaysMs?: number[];
            restoreRetryDelaysMs?: number[];
            /** Wait before retrying a restore after the peer's 491; `originated` = the gateway owns the Call-ID. */
            glareDelayMs?: (originated: boolean) => number;
            ackGiveUpMs?: number;
        } = {}
    ) {
        const mediaReady = options.media ?? (() => true);
        this.firewall = options.firewall;
        this.media = options.mediaController;
        this.handoffAckTimeoutMs = options.handoffAckTimeoutMs ?? HANDOFF_ACK_TIMEOUT_MS;
        this.terminalRetryDelaysMs = options.terminalRetryDelaysMs ?? TERMINAL_RETRY_DELAYS_MS;
        this.restoreRetryDelaysMs = options.restoreRetryDelaysMs ?? RESTORE_RETRY_DELAYS_MS;
        this.glareDelayMs = options.glareDelayMs ?? defaultGlareDelayMs;
        this.ackGiveUpMs = options.ackGiveUpMs ?? ACK_GIVE_UP_MS;
        this.signaling = signaling ?? new SipbridgeSignaling(config);
        this.signaling.applicationReady = () =>
            (!config.ROUTES_REQUIRED || config.ROUTES.length + (controlHub?.routeCount ?? 0) > 0) && (!config.RTPBRIDGE_REQUIRED || mediaReady());
        this.signaling.isDraining = () => lifecycle?.isDraining ?? false;
        if (this.firewall) {
            const firewall = this.firewall;
            this.signaling.banPolicy = source => !!source && firewall.shouldReject(source.ip);
            // With the firewall off, the in-handler route check answers; nothing runs at admission.
            if (firewall.config.mode !== 'off') this.signaling.routePolicy = (message, source) => this.admitRoute(message, source);
        }
    }
    private readonly firewall?: SipFirewall;
    /**
     * Route admission for a fresh INVITE that passed every protocol check; runs in the signaling layer before any
     * owner/RTC state exists. Unknown hosts and unrouted INVITEs get 404; the former always scores, the latter
     * only while owner routes are expected to be present (see routesExpected).
     */
    private admitRoute(message: SipMessage, source: SipSource | undefined): number | undefined {
        const firewall = this.firewall;
        if (!firewall || message.method !== 'INVITE') return undefined;
        const destinationUri = stripSipUri(message.uri);
        const destinationUser = getSipUser(destinationUri);
        const sourceIp = source?.ip;
        if (!acceptsSipHost(destinationUri, this.config.SIP_ALLOWED_DOMAINS)) {
            this.logger.info({ destinationUri, destinationUser, sourceIp }, 'Unknown SIP host for INVITE');
            if (sourceIp) firewall.observe(sourceIp, destinationUser, 'unknown-host');
            return 404;
        }
        if (this.controlHub?.findRoute({ destinationUri, destinationUser }) || matchRoute(this.config.ROUTES, { destinationUri, destinationUser }))
            return undefined;
        const scored = !!sourceIp && this.routesExpected(firewall.config.routeGraceMs);
        this.logger.info({ destinationUri, destinationUser, sourceIp, scored }, 'No route for INVITE');
        if (scored) firewall.observe(sourceIp, destinationUser, 'no-route');
        return 404;
    }
    /** A missing route is abuse evidence only while owners that would register it are connected and settled. */
    private routesExpected(graceMs: number): boolean {
        const hub = this.controlHub;
        if (!hub) return true;
        // Only connections that registered inbound routes are owners: an outbound-only connection must not make routes
        // look available while the real owner is away.
        const owners = hub.routeOwnerCount;
        const controlRouting = this.config.ROUTES.length === 0 || hub.hasHadRouteOwner || owners > 0;
        if (controlRouting && owners === 0) return false;
        return Date.now() - hub.lastRouteOwnerLossAt >= graceMs;
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
        let selectedControlRoute = this.controlHub?.findRoute(routeDestination);
        let selectedHttpRoute = matchRoute(this.config.ROUTES, routeDestination);

        if (!selectedControlRoute && !selectedHttpRoute) {
            this.logger.info({ destinationUri, destinationUser }, 'No route for INVITE');
            await res.respond(404);
            return;
        }

        let replacing: ActiveCall | undefined;
        // The specific dialog named by Replaces (RFC 3891): the return is only valid while it is still on the call.
        let replacedDialog: NativeDialog | undefined;
        // Presence, not truthiness: an empty Replaces value is malformed, never absent.
        const replaces = readHeaderRaw(req, 'replaces');
        if (replaces !== undefined) {
            const observe = (reason: string, replacement = false) =>
                this.firewall?.observe(req.source?.ip, destinationUser, reason, req.requestId, replacement);
            let identity;
            try {
                // RFC 3891 3: at most one Replaces header field. sipbridge keeps each header line separate, and a comma is
                // legal inside a quoted parameter value, so only a repeated header line is rejected here.
                if (replacesInstances(req) > 1) throw new Error('Multiple Replaces');
                identity = parseReplaces(replaces);
            } catch {
                observe('invalid-replaces');
                await res.respond(400);
                return;
            }
            const match = this.registry.findDialog(identity);
            if (!match) {
                // Unknown dialogs are scored only when the firewall opts in; the call is never treated as new.
                observe('unknown-replaces', true);
                await res.respond(481);
                return;
            }
            if (identity.earlyOnly) {
                await res.respond(486);
                return;
            }
            // Exact tags identify the dialog; either established peer of the call may send the replacement.
            const peerCheck = await this.isCallPeer(match.call, req.source?.ip);
            if (peerCheck.result === 'unresolved') {
                // The destination's address could not be resolved: neither authorized nor evidence of abuse.
                await res.respond(503, { headers: { 'Retry-After': '1' } });
                return;
            }
            if (peerCheck.result === 'no') {
                observe('unauthorized-replaces');
                await res.respond(403);
                return;
            }
            // The check awaited (DNS): the route may have moved to another owner, so it is selected again (the previous
            // owner must never receive the return invite).
            selectedControlRoute = this.controlHub?.findRoute(routeDestination);
            selectedHttpRoute = matchRoute(this.config.ROUTES, routeDestination);
            if (!selectedControlRoute && !selectedHttpRoute) {
                await res.respond(404);
                return;
            }
            // The check awaited (DNS): the dialog may have ended or been replaced meanwhile.
            const current = this.registry.findDialog(identity);
            if (!current || current.call !== match.call || !this.isLiveLeg(current.call, current.dialog)) {
                await res.respond(481);
                return;
            }
            // The authorizing leg may have been detached (e.g. a REFER return) while the lookup awaited: its authority ended with it.
            const authorizer = peerCheck.result === 'yes' ? peerCheck.leg : undefined;
            if (!authorizer || authorizer.isEnded || !this.isLiveLeg(match.call, authorizer)) {
                observe('unauthorized-replaces');
                await res.respond(403);
                return;
            }
            replacing = match.call;
            replacedDialog = current.dialog;
            if (replacing.ownership === 'application') {
                if ((selectedControlRoute?.connectionId ?? selectedHttpRoute?.url) !== (replacing.controlConnectionId ?? replacing.routeUrl)) {
                    await res.respond(403);
                    return;
                }
                // Same guard as a handed-off return: rejected before the owner is consulted or the old leg touched.
                if (!req.body) {
                    await res.respond(488);
                    return;
                }
                if (!incomingCarriesSdp(req)) {
                    await res.respond(415, { headers: { Accept: 'application/sdp' } });
                    return;
                }
                await this.replaceApplicationDialog(replacing, req, res);
                return;
            }
            if (replacing.ownership !== 'handed-off' || this.modifyingPairs.has(replacing)) {
                await res.respond(491);
                return;
            }
            // An offerless replacement is rejected before the pair is claimed or the app consulted: the initial ACK's SDP is
            // not surfaced to the owner, so committing would retire a working pair with no usable replacement media.
            if (!req.body || !incomingCarriesSdp(req)) {
                if (!req.body) await res.respond(488);
                else await res.respond(415, { headers: { Accept: 'application/sdp' } });
                return;
            }
            // I1: the claim is taken with no await between the check above and this assignment.
            replacing.ownership = 'returning';
        }

        let controlRoute = selectedControlRoute;
        let httpRoute = selectedHttpRoute;
        const sipCallId = req.callId || readHeader(req, 'call-id') || '';
        const callId = this.registry.reserveCallId(sipCallId);
        const inviteRequest = buildInviteRequest(req, callId, sipCallId, destinationUri, destinationUser);
        inviteRequest.logicalCallId = replacing?.logicalCallId ?? randomUUID();
        // Unique per return attempt: echoed on that attempt's answered/terminated events so an owner can tell attempts apart.
        const returnAttemptId = replacing ? randomUUID() : undefined;
        if (replacing) {
            inviteRequest.returning = true;
            inviteRequest.previousSessionId = replacing.callId;
            inviteRequest.returnAttemptId = returnAttemptId;
        }
        let routeUrl = controlRoute?.route.url ?? httpRoute!.url;

        let acceptedReceiverUrl: string | undefined;
        let answeredDialog: NativeDialog | undefined;
        let releaseMedia = () => {};
        // The original caller may have hung up while the application was consulted (RFC 3891 3: 603 when the
        // replaced dialog no longer exists to be replaced). Checked synchronously before and after the answer.
        const claimHeld = () => !replacing || (this.registry.get(replacing.callId) === replacing && replacing.ownership === 'returning');
        // The named dialog must still be an attached, live leg: its end detaches it but leaves the call `returning`.
        // A carrier that hung up leaves the call over (an ended leg differs from a fenced one, which is retired anyway): the
        // return must not commit onto it, even when the named leg is the destination.
        const replacedLegHeld = () =>
            !replacing || (!!replacedDialog && !replacedDialog.isEnded && this.isLiveLeg(replacing, replacedDialog) && !replacing.dialog.isEnded);
        this.pendingInboundCalls.set(callId, res);
        try {
            if (replacing) {
                // Settled BEFORE the route is chosen: a WebSocket owner may register the route during the wait, and the
                // stale HTTP owner must then never see the return invite. The claim and legs are revalidated afterwards.
                await this.settlePendingOwnerDeliveries(replacing);
                if (!claimHeld() || !replacedLegHeld()) {
                    this.logger.warn(
                        { callId, replacedCallId: replacing.callId },
                        'Replaced call ended while owner deliveries settled; rejecting INVITE'
                    );
                    await res.respond(603);
                    this.registry.releaseReservation(callId);
                    return;
                }
                controlRoute = this.controlHub?.findRoute(routeDestination);
                httpRoute = matchRoute(this.config.ROUTES, routeDestination);
                if (!controlRoute && !httpRoute) {
                    await res.respond(404);
                    this.registry.releaseReservation(callId);
                    return;
                }
                routeUrl = controlRoute?.route.url ?? httpRoute!.url;
            }
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

            // The selected owner must still be connected: a replacement committed to a dead connection would have nobody
            // to terminate it while both old legs are torn down.
            const ownerLive = () => !replacing || this.routeOwnerHolds(routeDestination, controlRoute, httpRoute);
            if (!claimHeld() || !replacedLegHeld() || !ownerLive()) {
                this.logger.warn({ callId, replacedCallId: replacing!.callId }, 'Replaced call ended or owner left during return; rejecting INVITE');
                // RFC 3891 3: a Replaces naming a dialog that has already terminated is declined with 603.
                await res.respond(603);
                this.registry.releaseReservation(callId);
                void this.sendFailedInviteEvent(controlRoute?.connectionId, acceptedReceiverUrl, {
                    event: 'terminated',
                    callId,
                    sipCallId,
                    reason: 'return-failed',
                    ...(returnAttemptId && { returnAttemptId }),
                    receivedAt: new Date().toISOString()
                });
                return;
            }

            // The endpoint may be reserved by a transfer in progress: checked before the answer is sent and again before
            // the call is activated (the answer awaits).
            this.assertMediaUnreserved(action.sdp);
            releaseMedia = this.claimLocalMedia(action.sdp);
            const dialog = await res.answer(action.sdp, action.headers);
            answeredDialog = dialog;
            this.lifecycle?.assertRunning();
            // The claim was lost during the answer: the caller is gone, so the new dialog is torn down (catch below).
            if (!claimHeld() || !replacedLegHeld()) throw new InvalidCallStateError('Replaced call ended during return');
            // The owner left while the answer was written: the replacement is BYEd (catch below) and the original pair,
            // still `returning`, is restored to handed-off by the finally block without touching its legs.
            if (!ownerLive()) throw new InvalidCallStateError('Return owner disconnected');
            // Both old legs are retired by the replacement (retireReplaced), so a fenced old leg does not block it.
            this.assertMediaUnreserved(action.sdp);
            const now = new Date().toISOString();
            const call = this.registry.activate({
                logicalCallId: inviteRequest.logicalCallId,
                remoteAddress: req.source?.ip,
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
            // The call now holds the endpoint through its committed SDP; the owner-less claim would only block a transfer
            // of the returned call while the old legs are retired below.
            releaseMedia();
            this.logger.info({ call: sipCallLogContext(call) }, 'SIP dialog answered');
            // Published at commit, before the old legs are awaited: a replacement that hangs up meanwhile must reach the
            // owner as answered then bye, never the reverse.
            void this.sendFollowUpEvent(call, {
                event: 'answered',
                callId,
                sipCallId,
                sdp: action.sdp,
                status: action.status ?? 200,
                headers: action.headers,
                ...(returnAttemptId && { returnAttemptId }),
                receivedAt: new Date().toISOString()
            });
            if (replacing) await this.retireReplaced(replacing);
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
                    ...(returnAttemptId && { returnAttemptId }),
                    receivedAt: new Date().toISOString()
                });
            }
            if (!res.finalResponseSent) {
                const status = sipStatusForError(err);
                await res.respond(status);
            }
        } finally {
            if (replacing && this.registry.get(replacing.callId) === replacing && replacing.ownership === 'returning') {
                if (replacing.peerDialog) {
                    replacing.ownership = 'handed-off';
                    // Fences during the return were deferred to this flow: a pair with an uncertain leg cannot be kept.
                    if (this.pairHasFencedLeg(replacing)) void this.byeCall(replacing, 'return-peer-uncertain').catch(() => undefined);
                }
                // The external party hung up while the application was consulted: nobody is left on that leg.
                else void this.bye(replacing.callId, 'return-failed-no-peer').catch(() => undefined);
            }
            releaseMedia();
            this.pendingInboundCalls.delete(callId);
        }
    }

    /**
     * Resolves which leg of the call, if any, `sourceIp` authenticates as: the observed (or, for outbound legs,
     * resolved configured) address of either leg. The leg is returned so the caller can re-verify it after the lookup.
     */
    private async isCallPeer(
        call: ActiveCall,
        sourceIp: string | undefined
    ): Promise<{ result: 'yes'; leg: NativeDialog | undefined } | { result: 'no' | 'unresolved' }> {
        if (!sourceIp) return { result: 'no' };
        const wanted = normalizeIp(sourceIp);
        const legs = [
            { dialog: call.dialog, ip: call.remoteAddress, known: undefined, host: call.remoteHost },
            { dialog: call.peerDialog, ip: call.peerAddress, known: call.peerAddresses, host: call.peerHost }
        ];
        let unresolved = false;
        for (const leg of legs) {
            let addresses: string[] | undefined = leg.ip ? [leg.ip] : leg.known;
            if (!addresses && leg.host) {
                addresses = await resolveHost(leg.host);
                if (!addresses) unresolved = true;
            }
            if (addresses?.some(address => normalizeIp(address) === wanted)) return { result: 'yes', leg: leg.dialog };
        }
        return { result: unresolved ? 'unresolved' : 'no' };
    }

    /** Detaches the replaced call's legs (I4) and ends them; the replacement already holds the logical call. */
    private async retireReplaced(replaced: ActiveCall) {
        if (this.registry.remove(replaced.callId) !== replaced) return;
        const legs = [replaced.dialog, replaced.peerDialog];
        replaced.peerDialog = undefined;
        await Promise.allSettled(legs.map(leg => leg && this.byeLeg(leg)));
    }

    /**
     * BYEs a leg unless it ended or is fenced; a fenced context is never commanded (I5) and is left to native timers.
     * A leg still owed its ACK gets it first (I6). Definite refusals are retried; if the ACK stays refused the BYE is
     * deferred until the peer has given up waiting for it, never sent without the ACK it is owed.
     */
    private async byeLeg(dialog: NativeDialog, headers?: SipHeaders) {
        if (dialog.isEnded || dialog.isFenced) return;
        const owed = this.ackOwed.get(dialog);
        if (owed) {
            try {
                await this.retryDefinite(dialog, owed.settle);
            } catch (err) {
                if (isDefiniteRefusal(err, dialog)) {
                    this.deferBye(dialog, headers, owed.answeredAt());
                    return;
                }
                // An uncertain ACK fenced the leg (checked below), which is never commanded again.
            }
        }
        if (dialog.isEnded || dialog.isFenced) return;
        await this.sendBye(dialog, headers);
    }

    /** Sends a BYE, retrying a bounded number of times while sipbridge definitely did not accept it. */
    private async sendBye(dialog: NativeDialog, headers?: SipHeaders) {
        try {
            await this.retryDefinite(dialog, () => dialog.bye(headers));
        } catch (err) {
            // sipbridge adds the dialog's own Route/framing headers to the caller's, so a large route set can push a BYE that
            // passed the gateway's header budget over its 64 KiB wire limit. That refusal is a generic NOT_ACCEPTED (its text
            // does not say "size"), so the headers are dropped only once the whole schedule with them was definitely refused:
            // terminating the leg outranks delivering custom headers.
            if (!headers || Object.keys(headers).length === 0 || !isDefiniteRefusal(err, dialog) || this.stopping) throw err;
            this.logger.warn({ failure: 'bye-headers-dropped' }, 'BYE with caller headers was refused every time; retrying without them');
            await this.retryDefinite(dialog, () => dialog.bye(undefined));
        }
    }

    /** Runs a terminal command, retrying definite non-acceptance with backoff; the last error is rethrown. */
    private async retryDefinite(
        dialog: NativeDialog,
        operation: () => Promise<unknown>,
        retryable: (err: unknown, dialog: NativeDialog) => boolean = isDefiniteRefusal
    ) {
        for (let attempt = 0; ; attempt++) {
            try {
                await operation();
                return;
            } catch (err) {
                if (!retryable(err, dialog) || attempt >= this.terminalRetryDelaysMs.length || this.stopping) throw err;
                await this.sleepForRetry(this.terminalRetryDelaysMs[attempt]);
                if (dialog.isEnded || dialog.isFenced || this.stopping) throw err;
            }
        }
    }

    /**
     * Rollback re-INVITE. After a carrier 2xx sipbridge ACKs asynchronously, so an immediate restore can be refused
     * locally (memory backend: NOT_ACCEPTED, sipStatus 0 "previous INVITE ACK not positively written"; Redis: 491 "ACK
     * output still pending"; or a local-capacity refusal). A definite local refusal sent nothing, so it is retried on a
     * short schedule. A peer's COMPLETED 491 is glare (RFC 3261 14.1) and waits a randomized 2.1-4s when the gateway owns
     * the Call-ID, else 0-2s. Retries are bounded and stop when the leg ended, was fenced, or the outcome is uncertain.
     */
    private async restoreReinvite(dialog: NativeDialog, sdp: string) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await dialog.reinvite(sdp);
            } catch (err) {
                if (!isRetryableRestoreRefusal(err, dialog) || attempt >= this.restoreRetryDelaysMs.length || this.stopping) throw err;
                const peerGlare = err instanceof NativeOperationError && err.completed && err.sipStatus === 491;
                await this.sleepForRetry(peerGlare ? this.glareDelayMs(dialog.isOutbound) : this.restoreRetryDelaysMs[attempt]);
                if (dialog.isEnded || dialog.isFenced || this.stopping) throw err;
            }
        }
    }

    private sleepForRetry(ms: number) {
        return new Promise<void>(resolve => {
            const sleep = {
                timer: setTimeout(() => {
                    this.retrySleeps.delete(sleep);
                    resolve();
                }, ms),
                wake: () => {
                    clearTimeout(sleep.timer);
                    this.retrySleeps.delete(sleep);
                    resolve();
                }
            };
            sleep.timer.unref();
            this.retrySleeps.add(sleep);
        });
    }

    /** Schedules the BYE for `ackGiveUpMs` after the 2xx whose ACK could not be sent (RFC 3261 13.3.1.4). */
    private deferBye(dialog: NativeDialog, headers: SipHeaders | undefined, answeredAt: number) {
        if (this.stopping) return;
        const delay = Math.max(0, answeredAt + this.ackGiveUpMs - Date.now());
        this.logger.warn({ failure: 'ack-refused-bye-deferred', delayMs: delay }, 'Owed ACK refused; deferring BYE until the peer gives up on it');
        const cleanup = () => {
            clearTimeout(timer);
            this.deferredByes.delete(timer);
        };
        const timer = setTimeout(() => {
            cleanup();
            dialog.off('ended', cleanup);
            if (dialog.isEnded || dialog.isFenced || this.stopping) return;
            this.sendBye(dialog, headers).catch(() =>
                this.logger.warn({ failure: 'deferred-bye-failed' }, 'Failed to terminate SIP dialog after refused ACK')
            );
        }, delay);
        timer.unref();
        this.deferredByes.add(timer);
        dialog.once('ended', cleanup);
    }

    private async replaceApplicationDialog(call: ActiveCall, req: IncomingSipRequest, res: SipResponse) {
        if (this.modifyingPairs.has(call)) {
            await res.respond(491);
            return;
        }
        this.modifyingPairs.add(call);
        let previousRemoteSdp = this.syncRemoteSdp(call);
        let prepared = false;
        let releaseMedia = () => {};
        let releaseRestore = () => {};
        try {
            const action = await this.sendFollowUpEvent(
                call,
                {
                    event: 'reinvite',
                    callId: call.callId,
                    sipCallId: call.sipCallId,
                    sdp: req.body,
                    headers: readHeaders(req),
                    receivedAt: new Date().toISOString()
                },
                true
            );
            if (action.action === 'reject') {
                await res.respond(action.status, { headers: action.headers });
                return;
            }
            prepared = true;
            this.assertLiveCall(call);
            this.assertMediaUnreserved(action.sdp, call);
            releaseMedia = this.claimLocalMedia(action.sdp, call);
            const replacement = await res.answer(action.sdp, action.headers);
            // The original dialog may have hung up while the answer was written (its terminal event is still pending).
            if (this.registry.get(call.callId) !== call || call.dialog.isEnded) {
                await this.byeLeg(replacement).catch(() => undefined);
                return;
            }
            try {
                this.assertMediaUnreserved(action.sdp, call);
            } catch (err) {
                await this.byeLeg(replacement).catch(() => undefined);
                throw err;
            }
            // I4: detach the old leg before it can emit anything that touches the call.
            const old = call.dialog;
            call.dialog = replacement;
            call.sipCallId = replacement.sipCallId;
            call.remoteAddress = req.source?.ip;
            call.remoteHost = undefined;
            this.updateCallSdp(call, { localSdp: action.sdp, remoteSdp: req.body });
            this.bindDialog(call);
            await this.byeLeg(old).catch(() => undefined);
        } catch (err) {
            // An offerless call's ACK may have supplied the baseline while the application prepared the replacement.
            if (prepared && !previousRemoteSdp && this.registry.get(call.callId) === call) {
                previousRemoteSdp = this.syncRemoteSdp(call);
                // Nothing to restore the media from: the application may already point at the replacement, so end the call.
                if (!previousRemoteSdp) await this.byeCall(call, 'replacement-restore-failed').catch(() => undefined);
            }
            if (prepared && previousRemoteSdp && this.registry.get(call.callId) === call) {
                try {
                    const restored = await this.sendFollowUpEvent(
                        call,
                        {
                            event: 'reinvite',
                            callId: call.callId,
                            sipCallId: call.sipCallId,
                            sdp: previousRemoteSdp,
                            receivedAt: new Date().toISOString()
                        },
                        true
                    );
                    if (restored.action !== 'answer') throw new Error('Application could not restore replaced media');
                    const committed = call.localSdp;
                    if (committed && !preservesMediaParameters(committed, restored.sdp, previousRemoteSdp)) {
                        // The application restored different local media: the original peer still sends to the old
                        // address, so it must be renegotiated onto the new one (or the call ends).
                        this.assertLiveCall(call);
                        if (call.dialog.isFenced) throw new InvalidCallStateError('Original dialog is fenced');
                        this.assertMediaUnreserved(restored.sdp, call);
                        // Held through commit/cleanup (released in the outer finally): another call's handoff must not destroy it.
                        releaseRestore = this.claimLocalMedia(restored.sdp, call);
                        const offer = relaySdp(restored.sdp, committed);
                        this.sentSdp.set(call.dialog, offer);
                        const answer = await this.restoreReinvite(call.dialog, offer);
                        // The application never sees this answer, so it must leave the carrier exactly where it was
                        // (address, direction, codecs, SDES keys); anything else cannot be kept and ends the call.
                        assertRollbackAnswer(answer, previousRemoteSdp, offer);
                        this.assertLiveCall(call);
                        this.assertMediaUnreserved(restored.sdp, call);
                        this.updateCallSdp(call, { localSdp: offer, remoteSdp: answer });
                    } else {
                        this.updateCallSdp(call, { localSdp: restored.sdp, remoteSdp: previousRemoteSdp });
                    }
                } catch {
                    await this.byeCall(call, 'replacement-restore-failed').catch(() => undefined);
                }
            }
            this.logger.warn({ callId: call.callId, failure: 'replacement-failed' }, 'Failed to replace application SIP dialog');
            if (!res.finalResponseSent) await res.respond(sipStatusForError(err)).catch(() => undefined);
        } finally {
            releaseRestore();
            releaseMedia();
            this.modifyingPairs.delete(call);
        }
    }

    /** RFC 3261 14.1 / RFC 5057: a leg whose dialog the peer reports gone ends the whole call (bye() BYEs every leg once). */
    private endIfDialogGone(call: ActiveCall, err: unknown, reason = 'dialog-gone') {
        if (!(err instanceof NativeOperationError) || !err.dialogGone) return;
        if (this.registry.get(call.callId) !== call) return;
        this.logger.warn({ callId: call.callId, sipStatus: err.sipStatus, reason }, 'SIP dialog reported gone; ending call');
        if (call.peerDialog) {
            void this.bye(call.callId, reason).catch(() => undefined);
            return;
        }
        // Single leg: removal is the token (taken synchronously) so a racing app BYE sees NOT_FOUND, not a conflict.
        const removed = this.registry.remove(call.callId);
        if (!removed) return;
        this.cancelTransferForCall(call);
        void this.byeLeg(removed.dialog).catch(() =>
            this.logger.warn({ callId: call.callId, failure: 'dialog-gone-bye-failed' }, 'Failed to terminate SIP dialog')
        );
        this.sendTerminated(removed, reason, {});
    }

    /** Runs `task` detached but tracked by the lifecycle (drain waits for it); failures are logged, never thrown. */
    private runBackground(failure: string, callId: string, task: () => Promise<void>) {
        const run = async () => {
            try {
                await task();
            } catch (err) {
                this.logger.warn({ callId, failure }, errorMessage(err));
            }
        };
        if (this.lifecycle && !this.lifecycle.isStopping) return this.lifecycle.track(run);
        return run();
    }

    /** Delivery of each call's own terminated event; a correlated attempt event for an HTTP owner waits for it to settle. */
    private terminatedDeliveries = new WeakMap<ActiveCall, Promise<void>>();
    /** In-flight HTTP delivery of each call's answered event (never rejects); the call's end event waits for it. */
    private answeredDeliveries = new WeakMap<ActiveCall, Promise<void>>();

    private sendTerminated(removed: ActiveCall, reason: string | undefined, headers: SipHeaders) {
        const delivery = this.sendFollowUpEvent(removed, {
            event: 'terminated',
            callId: removed.callId,
            sipCallId: removed.sipCallId,
            reason,
            headers,
            receivedAt: new Date().toISOString()
        });
        this.terminatedDeliveries.set(removed, delivery);
        void delivery.catch(() => undefined);
    }

    /** Writes SDP only while `call` is still the registered instance (a reused callId may belong to a newer call). */
    private updateCallSdp(call: ActiveCall, sdp: { localSdp?: string; remoteSdp?: string }) {
        if (this.registry.get(call.callId) === call) this.registry.updateSdp(call.callId, sdp);
    }

    /** Ends `call` only if it is still the registered instance; a stale async path never tears down a newer call. */
    private pairHasFencedLeg(call: ActiveCall) {
        return call.dialog.isFenced || !!call.peerDialog?.isFenced;
    }

    private async byeCall(call: ActiveCall, reason: string) {
        if (this.registry.get(call.callId) !== call) return;
        await this.bye(call.callId, reason);
    }

    /**
     * The call must still be the registered instance and its retained leg must not be known ended: a command result with
     * an ended snapshot marks the leg ended at once but the registry only drops the call when the terminal event arrives.
     */
    private assertLiveCall(call: ActiveCall) {
        if (this.registry.get(call.callId) !== call || call.dialog.isEnded) throw new InvalidCallStateError('Source SIP call ended during handoff');
    }

    /**
     * The carrier's negotiated SDP. An offerless inbound INVITE registers an empty body; the carrier's SDP arrives in the
     * ACK and only the native snapshot learns it, so it is copied into the registry the first time it is needed.
     */
    private syncRemoteSdp(call: ActiveCall) {
        if (!call.remoteSdp && call.dialog.remoteSdp) this.updateCallSdp(call, { remoteSdp: call.dialog.remoteSdp });
        return call.remoteSdp;
    }

    private async destroyFailedInviteDialog(dialog: NativeDialog, callId: string) {
        try {
            await this.sendBye(dialog);
        } catch (err) {
            this.logger.warn({ failure: 'signaling-or-owner-operation-failed', callId }, 'Failed to destroy SIP dialog after INVITE setup failure');
        }
    }

    async reinvite(callId: string, sdp: string, headers?: SipHeaders) {
        const call = this.registry.get(callId);
        if (!call) throw new CallNotFoundError(`Call ${callId} not found`);
        if (call.ownership && call.ownership !== 'application') throw new SipOperationConflictError('Call is owned by a SIP handoff');
        if (this.modifyingPairs.has(call)) throw new SipOperationConflictError('SIP renegotiation is in progress');
        this.assertMediaUnreserved(sdp, call);
        this.modifyingPairs.add(call);
        const releaseMedia = this.claimLocalMedia(sdp, call);
        try {
            const remoteSdp = await call.dialog.reinvite(sdp, headers);
            this.assertLiveCall(call);
            this.updateCallSdp(call, { localSdp: sdp, remoteSdp });
            return { sdp: remoteSdp };
        } catch (err) {
            if (err instanceof NativeOperationError && (err.uncertain || err.unavailable)) throw err;
            this.endIfDialogGone(call, err);
            throw new InvalidCallStateError(errorMessage(err));
        } finally {
            releaseMedia();
            this.modifyingPairs.delete(call);
        }
    }

    /**
     * Hands an established application call to an external SIP destination. The destination is dialed offerless
     * (late offer), recording is stopped, the carrier is re-INVITEd with the destination's offer and the destination
     * is ACKed with the carrier's answer. The gateway then keeps both dialogs and relays between them.
     */
    async transfer(params: SipTransferParams, controlConnectionId?: string): Promise<SipTransferStatus> {
        this.lifecycle?.assertAccepting();
        if (this.lifecycle) return this.lifecycle.track(() => this.admittedTransfer(params, controlConnectionId));
        return this.admittedTransfer(params, controlConnectionId);
    }

    private async admittedTransfer(params: SipTransferParams, controlConnectionId?: string): Promise<SipTransferStatus> {
        if (typeof params.transferId !== 'string' || !isValidTransferId(params.transferId)) throw new InvalidHttpActionError(TRANSFER_ID_ERROR);
        const call = this.registry.get(params.sessionId);
        if (!call) throw new CallNotFoundError('Source SIP session not found');
        if (call.controlConnectionId !== controlConnectionId) throw new InvalidCallStateError('Source SIP session belongs to another owner');
        const pending = this.transfers.get(call);
        if (pending) {
            if (pending.id !== params.transferId) throw new SipOperationConflictError('Another SIP transfer is in progress');
            return pending.promise;
        }
        if (call.transfer?.transferId === params.transferId) return call.transfer;
        const finishedIndex = call.finishedTransfers?.findIndex(entry => entry.transferId === params.transferId) ?? -1;
        if (finishedIndex >= 0) {
            const finished = call.finishedTransfers![finishedIndex];
            // Any later transfer that completed (a finished one after it, or the current one) supersedes the recorded failure.
            const superseded = call.finishedTransfers!.slice(finishedIndex + 1).some(entry => entry.state === 'completed');
            if (superseded || call.transfer?.state === 'completed') {
                throw new SipOperationConflictError('Transfer ID belongs to an earlier superseded transfer');
            }
            return finished;
        }
        // Admitted before but its result was evicted: the retry must never dial again.
        if (call.admittedTransferIds?.has(params.transferId)) {
            throw new SipOperationConflictError('Transfer ID was already used on this call and its result is no longer retained');
        }
        if (call.ownership !== 'application') throw new SipOperationConflictError('Call is not application-owned');
        if (this.modifyingPairs.has(call)) throw new SipOperationConflictError('SIP renegotiation is in progress');
        if (!/^sips?:[^\s\r\n]+$/i.test(params.requestUri)) throw new InvalidCallStateError('Invalid SIP transfer URI');
        const media = this.media;
        if (!media?.prepareHandoff || !media.assertHandoffMedia) throw new InvalidCallStateError('Handoff requires call media');
        if (!call.localSdp) throw new InvalidCallStateError('Source SIP dialog has no established media');
        // I5: an uncertain context is never commanded; native timers own its cleanup.
        if (call.dialog.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
        this.syncRemoteSdp(call);
        if ((call.admittedTransferIds?.size ?? 0) >= ADMITTED_TRANSFER_LIMIT) {
            throw new SipOperationConflictError('Too many transfers have been attempted on this call');
        }
        const sourceEndpointId = media.assertHandoffMedia(params.mediaSessionId, controlConnectionId, call.localSdp) || undefined;
        this.assertExclusiveMedia(call);
        // Reserved synchronously with the check above: from here until teardown completes no other call may bind to the
        // source endpoint, because the handoff destroys the media session behind it.
        this.mediaReservations.set(call, call.localSdp);
        const handoffSource = { endpointId: sourceEndpointId, sdp: call.localSdp };
        // Registered before ownership is claimed so an ID collision cannot strand the call in `transferring`.
        // Unique per attempt: the internal id is never derived from a callId another call may reuse.
        const handoffKey = `handoff:${randomUUID()}`;
        const handoffAttempt = this.registerPendingOutboundCall(handoffKey, call.controlConnectionId);
        (call.admittedTransferIds ??= new Set()).add(params.transferId);
        // I1: performTransfer takes ownership synchronously, before its first await.
        const operation = this.performTransfer(call, params, media, handoffAttempt, handoffKey, handoffSource);
        this.transfers.set(call, { id: params.transferId, promise: operation });
        try {
            return await operation;
        } finally {
            this.transfers.delete(call);
            if (this.mediaReservations.get(call) === handoffSource.sdp) this.mediaReservations.delete(call);
        }
    }

    /** Refuses `sdp` when it binds a local media endpoint reserved by a transfer of another call. */
    private assertMediaUnreserved(sdp: string | undefined, owner?: ActiveCall) {
        if (!sdp) return;
        for (const [call, reserved] of this.mediaReservations) {
            if (call === owner) continue;
            // A hostname cannot be compared with the reserved endpoint without resolving it: exclusivity is unknown.
            if (usesHostnameMedia(sdp) || sharesMediaEndpoint(sdp, reserved)) {
                throw new SipOperationConflictError('Media endpoint is reserved by a SIP handoff in progress');
            }
        }
    }

    /** Registers `sdp` as claimed local media until the returned release runs (call it in a `finally`). */
    private claimLocalMedia(sdp: string | undefined, owner?: ActiveCall): () => void {
        if (!sdp) return () => {};
        this.assertMediaUnreserved(sdp, owner);
        const claim = { owner, sdp };
        this.pendingLocalMedia.add(claim);
        return () => {
            this.pendingLocalMedia.delete(claim);
        };
    }

    /**
     * Registered calls whose localSdp can name a local endpoint: a pair with an external peer holds that peer's SDP instead.
     * Paired calls are deliberately outside exclusivity (their SDP names external endpoints, so including them would cause
     * cross-tenant false refusals); a remote SDP naming a local endpoint is an RTP source-validation concern.
     */
    private localMediaSdps() {
        return this.registry.list().filter(other => !this.registry.get(other.callId)?.peerDialog);
    }

    /**
     * The handoff destroys the media session behind the call's local SDP: no other registered call may be using it,
     * neither as its committed SDP nor as any SDP it is still negotiating (a failed negotiation leaves the committed one).
     */
    private assertExclusiveMedia(call: ActiveCall) {
        if (!call.localSdp) return;
        // A hostname connection address cannot be compared without resolving it, so exclusivity cannot be established.
        const hostname = (sdp: string | undefined) => !!sdp && usesHostnameMedia(sdp);
        if (
            hostname(call.localSdp) ||
            this.localMediaSdps().some(other => hostname(other.localSdp)) ||
            [...this.pendingLocalMedia].some(claim => hostname(claim.sdp))
        ) {
            throw new InvalidCallStateError(
                'Handoff media exclusivity cannot be established: an active SIP call binds a hostname connection address'
            );
        }
        const shares = (sdp: string | undefined) => {
            if (!sdp) return false;
            try {
                return sharesMediaEndpoint(call.localSdp!, sdp);
            } catch {
                return false;
            }
        };
        const shared =
            this.localMediaSdps().some(other => other.callId !== call.callId && shares(other.localSdp)) ||
            [...this.pendingLocalMedia].some(claim => claim.owner !== call && shares(claim.sdp));
        if (shared) throw new InvalidCallStateError('Handoff media endpoint is shared with another SIP call');
    }

    private async performTransfer(
        call: ActiveCall,
        params: SipTransferParams,
        media: GatewayMediaController,
        pending: PendingOutboundSipCall,
        handoffKey: string,
        handoffSource: { endpointId?: string; sdp: string }
    ): Promise<SipTransferStatus> {
        call.ownership = 'transferring';
        this.modifyingPairs.add(call);
        const status: SipTransferStatus = {
            transferId: params.transferId,
            logicalCallId: call.logicalCallId!,
            state: 'transferring',
            startedAt: new Date().toISOString(),
            recordings: []
        };
        // The previous attempt is finished (none is pending): remember its result before it is overwritten.
        if (call.transfer) {
            call.finishedTransfers = [...(call.finishedTransfers ?? []), call.transfer].slice(-FINISHED_TRANSFER_LIMIT);
        }
        call.transfer = status;
        this.transferRequests.set(call, pending);
        let attempt: OutboundAttempt | undefined;
        let destination: NativeDialog | undefined;
        let destinationOffer = '';
        let destinationAck: Promise<void> | undefined;
        let relayedOffer = '';
        let switched = false;
        let carrierPending = false;
        let expired = false;
        let timer: NodeJS.Timeout | undefined;
        // Owner-scoped media guard: a stale attempt must never release a later attempt's recording suspension.
        const handoffToken = {};
        const previousSdp = call.localSdp;
        // Captured immediately before the first carrier re-INVITE (an offerless inbound call learns it from its ACK).
        let previousRemoteSdp: string | undefined;
        // I6: the single ACK for the destination's late-offer 2xx, taken synchronously by whichever path gets there first.
        let destinationAnsweredAt = Date.now();
        const ackDestination = async (sdp: string) => {
            if (destinationAck) return false;
            const sending = destination!.ackAnswer(sdp);
            destinationAck = sending;
            try {
                await sending;
            } catch (err) {
                // A definitely refused ACK may be sent again; an uncertain one fenced the leg.
                if (destinationAck === sending && !(err instanceof NativeOperationError && err.uncertain)) destinationAck = undefined;
                throw err;
            }
            this.ackOwed.delete(destination!);
            return true;
        };
        // Whichever path ends the call first settles the owed ACK through this (a rejection) before any BYE.
        const settleDestinationAck = async () => {
            if (destinationAck) await destinationAck;
            else await ackDestination(rejectSdpOffer(destinationOffer));
        };
        try {
            attempt = this.signaling.openDialog({
                requestUri: params.requestUri,
                sdp: '',
                headers: params.headers,
                proxy: params.proxy,
                auth: params.auth,
                callingNumber: params.callingNumber,
                callingName: params.callingName
            });
            pending.attempt = attempt;
            // Destination provisional responses (including early SDP) are observed for logging only, never relayed.
            attempt.onProvisional = provisional => this.logger.debug({ callId: call.callId, provisional }, 'Handoff destination provisional');
            if (pending.cancelRequested) await attempt.cancel();
            destination = await attempt.completed;
            pending.answered = true;
            // Recorded before any check can fail: an answered destination is owed an ACK whatever happens next (I6).
            // A body that is not SDP (mislabeled) is no late offer: sipbridge already ACKed it with an empty ACK and accepts no
            // ACK answer, so nothing is owed and the transfer fails before recordings or the carrier are touched.
            destinationOffer = destination.answerIsSdp !== false ? destination.remoteSdp : '';
            destinationAnsweredAt = Date.now();
            if (destinationOffer) this.ackOwed.set(destination, { settle: settleDestinationAck, answeredAt: () => destinationAnsweredAt });
            this.assertLiveCall(call);
            if (pending.cancelRequested) throw new InvalidCallStateError('Transfer cancelled');
            if (!destinationOffer) throw new InvalidCallStateError('Destination provided no late offer');
            relayedOffer = relaySdp(destinationOffer, call.localSdp);
            const negotiate = async () => {
                // Re-checked at the last moment before media is touched: another call may have claimed the endpoint meanwhile.
                this.assertExclusiveMedia(call);
                // Checked before prepareHandoff: a transfer that cannot proceed must not have stopped recordings.
                if (!this.syncRemoteSdp(call)) throw new InvalidCallStateError('Carrier media is not yet established');
                // I3: recording is stopped and confirmed before any destination SDP reaches the carrier.
                status.recordings = await media.prepareHandoff!(params.mediaSessionId, call.controlConnectionId, handoffToken, handoffSource);
                this.assertLiveCall(call);
                if (expired) throw new InvalidCallStateError('Transfer ACK deadline expired');
                if (call.dialog.isFenced || destination!.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
                if (destination!.isEnded) throw new InvalidCallStateError('Destination ended during handoff');
                // The rollback baseline is the carrier's negotiated SDP now, not at admission: an offerless inbound call's
                // ACK may have arrived while the destination rang. Still unknown: fail before the carrier is touched.
                previousRemoteSdp = this.syncRemoteSdp(call);
                if (!previousRemoteSdp) throw new InvalidCallStateError('Carrier media is not yet established');
                carrierPending = true;
                let answer: string;
                try {
                    answer = await call.dialog.reinvite(relayedOffer);
                } catch (err) {
                    // A definite refusal or rejection means the carrier never switched media: no timeout BYE is owed.
                    if (err instanceof NativeOperationError && !err.uncertain) carrierPending = false;
                    throw err;
                }
                // The carrier accepted the destination's media; failures from here on must restore its previous media.
                switched = true;
                this.sentSdp.set(call.dialog, relayedOffer);
                assertDirectMediaAnswer(destinationOffer, answer);
                // A late carrier answer must not leave the caller connected to an abandoned destination.
                if (expired) throw new InvalidCallStateError('Transfer ACK deadline expired');
                this.assertLiveCall(call);
                if (!(await ackDestination(answer))) throw new InvalidCallStateError('Transfer ACK deadline expired');
                this.sentSdp.set(destination!, answer);
                if (expired) throw new InvalidCallStateError('Transfer ACK deadline expired');
                this.assertLiveCall(call);
                if (destination!.isEnded) throw new InvalidCallStateError('Destination ended during handoff');
                this.updateCallSdp(call, { localSdp: relayedOffer, remoteSdp: answer });
            };
            await Promise.race([
                negotiate(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        expired = true;
                        reject(new InvalidCallStateError('Transfer ACK deadline expired'));
                    }, this.handoffAckTimeoutMs);
                })
            ]);
            // Commit synchronously (I1), re-checking liveness after the race resolved.
            this.assertLiveCall(call);
            // The carrier may have fenced while the destination ACK was in flight; the catch takes the carrier-lost path.
            if (call.dialog.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
            if (destination.isEnded) throw new InvalidCallStateError('Destination ended during handoff');
            call.peerDialog = destination;
            call.peerAddress = destination.peerSource?.ip;
            call.peerHost = call.peerAddress ? undefined : uriHost(params.proxy ?? params.requestUri);
            if (call.peerHost) {
                const host = call.peerHost;
                // Recorded for later Replaces authorization so it does not depend on DNS at that moment.
                void resolveHost(host).then(addresses => {
                    if (addresses?.length && call.peerHost === host) call.peerAddresses = addresses;
                });
            }
            call.ownership = 'handed-off';
            // Committed: the attempt leaves every cancellation map before completion is published or media cleanup is
            // awaited, so an application disconnect can no longer cancel (and thereby BYE) the now-established destination.
            if (this.pendingOutboundCalls.get(handoffKey) === pending) this.pendingOutboundCalls.delete(handoffKey);
            if (this.transferRequests.get(call) === pending) this.transferRequests.delete(call);
            this.bindDialog(call, destination);
            status.state = 'completed';
            status.destinationSipCallId = destination.sipCallId;
            status.committedAt = new Date().toISOString();
            call.updatedAt = status.committedAt;
            if (call.controlConnectionId) {
                this.controlHub?.sendEvent(call.controlConnectionId, { event: 'sip.transferred', sessionId: call.callId, data: status });
            } else {
                void this.sendFollowUpEvent(call, {
                    event: 'transferred',
                    callId: call.callId,
                    sipCallId: call.sipCallId,
                    transfer: status,
                    receivedAt: status.committedAt
                });
            }
            // Recording has already stopped. Residual media cleanup cannot undo a committed conversation.
            await media.destroySession(params.mediaSessionId).catch(() => {
                this.logger.warn({ callId: call.callId, failure: 'handoff-media-release-failed' }, 'Failed to release handed-off media');
            });
            return status;
        } catch (err) {
            status.state = 'failed';
            status.failure = 'SIP handoff failed';
            const live = this.registry.get(call.callId) === call;
            const destinationUsableNow = () => !!destination && !destination.isEnded && !destination.isFenced;
            // A fenced carrier (UNKNOWN re-INVITE outcome) or an expired ACK deadline with the carrier switch pending
            // leaves the call unrecoverable: the registry token is taken synchronously, before any command (I7).
            // A carrier known to have ended (an ended command result whose terminal event is still pending) is lost as well.
            const lostReasonNow = () =>
                call.dialog.isFenced ? 'transfer-carrier-uncertain' : call.dialog.isEnded ? 'transfer-carrier-ended' : 'transfer-ack-timeout';
            const carrierLost = live && (call.dialog.isFenced || call.dialog.isEnded || (expired && carrierPending));
            const removedCall = carrierLost ? this.registry.remove(call.callId) : undefined;
            const lostReason = lostReasonNow();
            // The terminal event does not wait for any command (the carrier may be hung on a queued re-INVITE).
            if (removedCall) this.sendTerminated(removedCall, lostReason, {});
            // I6 first: the answered destination is ACKed (a rejection) before any slower carrier restoration, so its
            // 2xx is never left waiting for the restore re-INVITEs.
            let destinationAckRefused = false;
            if (destinationUsableNow() && destinationOffer) {
                try {
                    // An ACK already in flight is awaited so the BYE below can never overtake it.
                    await this.retryDefinite(destination!, settleDestinationAck);
                } catch (ackErr) {
                    destinationAckRefused = isDefiniteRefusal(ackErr, destination!);
                    this.logger.warn(
                        { callId: call.callId, failure: 'handoff-destination-ack-failed' },
                        'Failed to reject handoff destination offer'
                    );
                }
            }
            // The carrier may have switched to an offer the destination will never complete; end that call (a fenced
            // carrier is never commanded; byeLeg skips it).
            // Not awaited: a hung carrier re-INVITE must not hold up the terminal event or the transfer result.
            if (removedCall)
                void this.byeLeg(call.dialog).catch(() =>
                    this.logger.warn(
                        { callId: call.callId, failure: 'transfer-carrier-bye-failed' },
                        'Failed to terminate carrier after failed handoff'
                    )
                );
            // The destination BYE (after its owed ACK, I6) runs concurrently with the carrier restore: restore retries
            // under outbound glare backoff must not hold the destination in a dead confirmed dialog. Awaited below.
            const destinationCleanup = destinationUsableNow()
                ? (async () => {
                      try {
                          if (destinationAckRefused) this.deferBye(destination!, undefined, destinationAnsweredAt);
                          else await this.sendBye(destination!);
                      } catch {
                          this.logger.warn(
                              { callId: call.callId, failure: 'handoff-destination-cleanup-failed' },
                              'Failed to clean up handoff destination'
                          );
                      }
                  })()
                : undefined;
            if (!removedCall && switched && live && !call.dialog.isFenced && !call.dialog.isEnded) {
                try {
                    const restore = relaySdp(previousSdp!, relayedOffer);
                    this.sentSdp.set(call.dialog, restore);
                    const answer = await this.restoreReinvite(call.dialog, restore);
                    // The app's RTP endpoint still sends to the carrier's previous media address: a rejected audio stream
                    // or a moved address cannot be repaired here, so the call ends. Extra formats are legal (RFC 3264 6.1).
                    // It must also keep the voice codec the application's RTP endpoint negotiated against the carrier's previous SDP.
                    assertRollbackAnswer(answer, previousRemoteSdp!, restore);
                    this.updateCallSdp(call, { localSdp: restore, remoteSdp: answer });
                } catch {
                    await this.byeCall(call, 'transfer-restore-failed').catch(() => undefined);
                }
            }
            await destinationCleanup;
            if (!destinationCleanup && !destination && attempt) {
                // A setup failure (for example the native setup deadline) must not leave the destination ringing.
                await attempt.cancel().catch(() => undefined);
            }
            if (this.registry.get(call.callId) === call && call.ownership === 'transferring') {
                if (call.dialog.isFenced || call.dialog.isEnded) {
                    // The carrier was lost while the destination was being cleaned up: it cannot be handed back to the
                    // application. The registry token is taken synchronously and the termination reported once (I7).
                    const removed = this.registry.remove(call.callId);
                    if (removed) {
                        this.cancelTransferForCall(removed);
                        this.sendTerminated(removed, lostReasonNow(), {});
                    }
                } else call.ownership = 'application';
            }
            // After the destination ACK/BYE (I6). A switched or timed-out call is already ended by the paths above.
            if (!removedCall && !switched) this.endIfDialogGone(call, err);
            // A fenced context cannot be cleaned up by this process; the caller must not replay the transfer.
            if (call.dialog.isFenced || destination?.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
            if (err instanceof NativeOperationError && (err.uncertain || err.unavailable)) throw err;
            throw new InvalidCallStateError(errorMessage(err));
        } finally {
            if (timer) clearTimeout(timer);
            media.releaseHandoff?.(params.mediaSessionId, handoffToken);
            this.modifyingPairs.delete(call);
            if (this.transferRequests.get(call) === pending) this.transferRequests.delete(call);
            pending.finish();
            if (this.pendingOutboundCalls.get(handoffKey) === pending) this.pendingOutboundCalls.delete(handoffKey);
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
        let answered: NativeDialog | undefined;
        let releaseMedia = () => {};
        try {
            this.assertMediaUnreserved(params.sdp);
            releaseMedia = this.claimLocalMedia(params.sdp);
            pending.attempt = this.signaling.openDialog(params);
            if (pending.cancelRequested) {
                // A definitely refused CANCEL leaves setup pending: a destination that answers meanwhile is still
                // delivered below and BYEd (after its owed ACK). Only an unknown outcome ends the attempt here.
                await pending.attempt.cancel().catch(err => {
                    if (!(err instanceof NativeOperationError) || err.uncertain) throw err;
                });
            }
            const dialog = await pending.attempt.completed;
            answered = dialog;
            pending.answered = true;
            const answeredAt = Date.now();

            if (pending.cancelRequested || dialog.isEnded || this.lifecycle?.isStopping) {
                // A destination that answered a cancelled late-offer setup (CANCEL refused or lost the race) is owed an
                // ACK (a rejection) before its BYE (I6).
                const offer = dialog.remoteSdp;
                if (!params.sdp && offer && !dialog.isEnded && !dialog.isFenced) {
                    this.ackOwed.set(dialog, {
                        settle: async () => {
                            await dialog.ackAnswer(rejectSdpOffer(offer));
                            this.ackOwed.delete(dialog);
                        },
                        answeredAt: () => answeredAt
                    });
                }
                await this.byeLeg(dialog);
                throw new InvalidCallStateError('Outbound SIP call was cancelled');
            }

            const localSdp = dialog.localSdp || params.sdp;
            try {
                this.assertMediaUnreserved(localSdp);
            } catch (err) {
                await this.byeLeg(dialog).catch(() => undefined);
                throw err;
            }
            // An offerless INVITE binds the media the destination's answer names: claimed from here to activation.
            const releaseAnswered = this.claimLocalMedia(localSdp);
            const previousRelease = releaseMedia;
            releaseMedia = () => {
                previousRelease();
                releaseAnswered();
            };
            const sipCallId = dialog.sipCallId;
            const callId = this.registry.reserveCallId(sipCallId);
            const now = new Date().toISOString();
            const destinationUri = stripSipUri(params.requestUri);
            const call = this.registry.activate({
                remoteHost: uriHost(params.proxy ?? params.requestUri),
                callId,
                sipCallId,
                routeUrl: receiverUrl,
                receiverUrl,
                controlConnectionId: params.controlConnectionId,
                destinationUri,
                destinationUser: getSipUser(destinationUri),
                sourceUri: getSourceUri(params.headers),
                localSdp,
                remoteSdp: dialog.remoteSdp,
                createdAt: now,
                updatedAt: now,
                dialog
            });

            this.bindDialog(call);
            this.logger.info({ call: sipCallLogContext(call) }, 'Outbound SIP dialog answered');
            return { sessionId: callId, sipCallId, sdp: dialog.remoteSdp };
        } catch (err) {
            // The setup failed without ever delivering a dialog (for example the native setup deadline, or CANCEL retries
            // ran out): CANCEL is issued once more, best effort and bounded (the native retry schedule stops on shutdown),
            // so a destination still ringing is not left to answer a call nobody owns. This holds even when the app's
            // cancel already ran: its CANCEL may have been refused definitively (a second CANCEL on a finished attempt is
            // harmless, and command() refuses fenced or ended contexts).
            if (pending.attempt && !answered && !this.stopping && !(err instanceof NativeOperationError && err.unavailable)) {
                void pending.attempt.cancel().catch(() => undefined);
            }
            if (pending.cancelRequested) this.logger.info(logContext, 'Outbound SIP dialog cancelled');
            else this.logger.warn({ failure: 'signaling-or-owner-operation-failed', ...logContext }, 'Outbound SIP dialog failed');
            if (err instanceof NativeOperationError && (err.uncertain || err.unavailable)) throw err;
            throw new InvalidCallStateError(errorMessage(err));
        } finally {
            releaseMedia();
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
        if (pending.attempt && !pending.answered) {
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
        this.stopping = true;
        for (const sleep of [...this.retrySleeps]) sleep.wake();
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
        for (const timer of this.deferredByes) clearTimeout(timer);
        this.deferredByes.clear();
        await this.signaling.stop();
    }

    async bye(callId: string, reason?: string, headers?: SipHeaders) {
        const call = this.registry.get(callId);
        if (!call) throw new CallNotFoundError(`Call ${callId} not found`);

        const byeHeaders = { ...(headers ?? {}) };
        // Caller headers are validated exactly as the native layer encodes them, before the registry token is taken: an
        // invalid header rejects the request and leaves the call (and both legs) untouched.
        try {
            dialogRequestHeaders(byeHeaders);
        } catch (err) {
            throw new InvalidHttpActionError(errorMessage(err));
        }

        if (call.peerDialog) {
            // I7: removing the call from the registry is the single token that authorizes the paired BYE.
            const removed = this.registry.remove(callId);
            if (!removed) throw new CallNotFoundError(`Call ${callId} not found`);
            this.cancelTransferForCall(removed);
            const peer = removed.peerDialog;
            removed.peerDialog = undefined;
            const legs = [removed.dialog, ...(peer ? [peer] : [])];
            // Published with the registry token, before any leg BYE is awaited: a correlated return-aborted for the same
            // call (sent by a pending return) can then never overtake the call's own end event.
            this.sendTerminated(removed, reason, byeHeaders);
            const outcomes = await Promise.allSettled(legs.map(leg => this.byeLeg(leg, byeHeaders)));
            const failed = outcomes.find(outcome => outcome.status === 'rejected');
            // A fenced leg's BYE is skipped; its outcome is unknown and native timers own the cleanup.
            if (legs.some(leg => leg.isFenced)) throw new NativeOperationError('Native signaling outcome unknown', true);
            if (failed?.status === 'rejected') {
                if (failed.reason instanceof NativeOperationError && (failed.reason.uncertain || failed.reason.unavailable)) throw failed.reason;
                throw new InvalidCallStateError(errorMessage(failed.reason));
            }
            return;
        }

        // I7: the registry token is taken before commanding, as in the paired branch. A fenced leg is never commanded
        // and a refused BYE is retried; either way the call is gone and its termination is reported exactly once.
        const removed = this.registry.remove(callId);
        if (!removed) throw new CallNotFoundError(`Call ${callId} not found`);
        this.cancelTransferForCall(removed);
        const leg = removed.dialog;
        let failure: unknown;
        this.sendTerminated(removed, reason, byeHeaders);
        try {
            await this.byeLeg(leg, byeHeaders);
        } catch (err) {
            failure = err;
        }
        if (leg.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
        if (failure) {
            if (failure instanceof NativeOperationError && (failure.uncertain || failure.unavailable)) throw failure;
            throw new InvalidCallStateError(errorMessage(failure));
        }
    }

    private cancelTransferForCall(call: ActiveCall) {
        const pending = this.transferRequests.get(call);
        if (!pending) return;
        pending.cancelRequested = true;
        // After the answer, CANCEL would mark the selected dialog retiring and block the ACK-aware BYE cleanup.
        if (pending.answered) return;
        void pending.attempt?.cancel().catch(() => undefined);
    }

    async terminateCallsForControlConnection(connectionId: string) {
        const pendingCancellations = [...this.pendingOutboundCalls.entries()]
            .filter(([, pending]) => pending.controlConnectionId === connectionId)
            .map(([outboundAttemptId]) => this.cancelOutbound(outboundAttemptId, connectionId));
        // Handed-off and returning calls no longer depend on the application connection.
        const calls = this.registry
            .list()
            .filter(call => call.controlConnectionId === connectionId && call.ownership !== 'handed-off' && call.ownership !== 'returning')
            .map(call => this.registry.remove(call.callId))
            .filter((call): call is ActiveCall => !!call);
        await Promise.allSettled([
            ...pendingCancellations,
            ...calls.map(async call => {
                this.cancelTransferForCall(call);
                try {
                    await this.byeLeg(call.dialog);
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

    private isLiveLeg(call: ActiveCall, dialog: NativeDialog) {
        return this.registry.get(call.callId) === call && (dialog === call.dialog || dialog === call.peerDialog);
    }

    private bindDialog(call: ActiveCall, dialog: NativeDialog = call.dialog) {
        dialog.on('request', (req: IncomingSipRequest, res: SipResponse) => {
            const fail = (err: unknown) => {
                this.logger.error(
                    { failure: 'signaling-or-owner-operation-failed', callId: call.callId, err: errorMessage(err) },
                    'Unhandled in-dialog request error'
                );
                if (!res.finalResponseSent) void res.respond(500).catch(() => undefined);
            };
            // I4: a leg that was detached or replaced no longer speaks for the call.
            if (!this.isLiveLeg(call, dialog)) {
                void res.respond(481).catch(() => undefined);
                return;
            }
            if (req.method === 'REFER') {
                this.handleRefer(call, dialog, req, res).catch(fail);
            } else if (req.method === 'UPDATE' && !req.body) {
                // A refresh without SDP changes no media; it is answered per dialog and never relayed.
                void res.respond(200).catch(fail);
            } else if (call.peerDialog) {
                this.handlePairedModify(call, dialog, req, res).catch(fail);
            } else {
                this.handleRemoteModify(call.callId, req, res).catch(fail);
            }
        });

        // An uncertain outcome on a leg of a paired call (handed-off or returning) can never be repaired: the fenced leg is never
        // commanded again (I5), so relaying through it would fail forever. Deferred so an in-flight handler that already
        // handles the fence runs its own path first; byeCall's registry token makes whichever comes second a no-op (I7).
        // Single-leg application calls are excluded: their owner sees SIGNALING_UNKNOWN errors instead.
        // Returns and transfers own fence handling: a fenced destination being retired must not end a return that can
        // still succeed, and a fenced carrier takes their explicit paths. Those flows end the call on restoring handed-off.
        const flowOwnsFence = () => call.ownership === 'returning' || call.ownership === 'transferring';
        const endOnFence = () => {
            if (flowOwnsFence()) return;
            setImmediate(() => {
                // I4: a detached leg no longer speaks for the call.
                if (flowOwnsFence() || !call.peerDialog || !this.isLiveLeg(call, dialog)) return;
                this.logger.warn({ callId: call.callId, failure: 'paired-leg-uncertain' }, 'Leg of a paired call fenced; ending call');
                void this.byeCall(call, 'leg-uncertain').catch(() => undefined);
            });
        };
        dialog.once('fenced', endOnFence);
        if (dialog.isFenced) endOnFence();

        dialog.on('ended', reason => {
            if (!this.isLiveLeg(call, dialog)) return;
            // A destination that hangs up after sending the return REFER (a blind transfer) is simply detached; the
            // return proceeds and, if it fails, ends the call because nobody is left on the external leg.
            if (call.ownership === 'returning' && dialog === call.peerDialog) {
                call.peerDialog = undefined;
                call.peerAddress = undefined;
                call.peerHost = undefined;
                call.peerAddresses = undefined;
                return;
            }
            // I7: registry removal is the token; only the caller that removes the call BYEs the other leg.
            const removed = this.registry.remove(call.callId);
            if (!removed) return;
            this.cancelTransferForCall(call);
            const peer = dialog === call.dialog ? call.peerDialog : call.dialog;
            call.peerDialog = undefined;
            if (peer)
                void this.byeLeg(peer).catch(() =>
                    this.logger.warn({ callId: call.callId, failure: 'paired-bye-failed' }, 'Failed to terminate paired SIP dialog')
                );

            const event = reason === 'bye' ? 'bye' : 'terminated';
            const delivery = this.sendFollowUpEvent(removed, {
                event,
                callId: removed.callId,
                sipCallId: removed.sipCallId,

                receivedAt: new Date().toISOString()
            });
            // Recorded so a correlated return-aborted never overtakes the peer-BYE event.
            this.terminatedDeliveries.set(removed, delivery);
            void delivery.catch(() => undefined);
        });
        dialog.activate();
    }

    private legSdp(dialog: NativeDialog) {
        return this.sentSdp.get(dialog) || dialog.localSdp || undefined;
    }

    private async handlePairedModify(call: ActiveCall, dialog: NativeDialog, req: IncomingSipRequest, res: SipResponse) {
        if (this.modifyingPairs.has(call) || call.ownership !== 'handed-off') {
            await res.respond(491);
            return;
        }
        const peer = dialog === call.dialog ? call.peerDialog : call.dialog;
        if (!peer) {
            await res.respond(481);
            return;
        }
        // I5: never command a fenced context.
        if (peer.isFenced || dialog.isFenced) {
            await res.respond(503, { headers: { 'Retry-After': '1' } });
            return;
        }
        // Only an application/sdp body is an offer. Any other non-empty body is refused before a cross-leg command.
        if (req.body && !incomingCarriesSdp(req)) {
            await res.respond(415, { headers: { Accept: 'application/sdp' } });
            return;
        }
        this.modifyingPairs.add(call);
        try {
            if (!req.body) await this.relayOfferlessModify(call, dialog, peer, req, res);
            else await this.relayOfferedModify(call, dialog, peer, req, res);
        } finally {
            this.modifyingPairs.delete(call);
        }
    }

    private recordCarrierSdp(call: ActiveCall, dialog: NativeDialog, local: string, remote: string) {
        if (dialog === call.dialog) this.updateCallSdp(call, { localSdp: local, remoteSdp: remote });
    }

    private async relayOfferedModify(call: ActiveCall, dialog: NativeDialog, peer: NativeDialog, req: IncomingSipRequest, res: SipResponse) {
        let peerAccepted = false;
        try {
            const offer = relaySdp(req.body, this.legSdp(peer));
            const answer = await peer.reinvite(offer);
            peerAccepted = true;
            this.sentSdp.set(peer, offer);
            this.assertLiveCall(call);
            const localAnswer = relaySdp(answer, this.legSdp(dialog));
            await res.respond(200, { body: localAnswer, headers: SDP_HEADERS });
            this.sentSdp.set(dialog, localAnswer);
            this.recordCarrierSdp(call, dialog, localAnswer, req.body);
            // The peer's own side of the exchange changed; the carrier leg's view is recorded above when it is the requester.
            if (peer === call.dialog) this.updateCallSdp(call, { localSdp: offer, remoteSdp: answer });
        } catch (err) {
            this.logger.warn({ callId: call.callId, failure: 'paired-renegotiation-failed' }, errorMessage(err));
            if (!res.finalResponseSent) await res.respond(isGlare(err) ? 491 : 488).catch(() => undefined);
            if (!peerAccepted) {
                if (this.peerOutcomeUnknown(err, peer)) await this.endUncertainPair(call);
                else this.endIfDialogGone(call, err);
            }
            // The peer already moved to the new media but the requester never got its answer: the legs disagree.
            if (peerAccepted && this.registry.get(call.callId) === call) await this.byeCall(call, 'renegotiation-failed').catch(() => undefined);
        }
    }

    /** True when the cross-leg re-INVITE's outcome is unknown, so the legs' media may have diverged. */
    private peerOutcomeUnknown(err: unknown, peer: NativeDialog) {
        return (err instanceof NativeOperationError && err.uncertain) || peer.isFenced;
    }

    /** I7: bye() removes the call first (the single token), skips fenced legs, and BYEs the usable one exactly once. */
    private async endUncertainPair(call: ActiveCall) {
        if (this.registry.get(call.callId) !== call) return;
        await this.byeCall(call, 'renegotiation-uncertain').catch(() => undefined);
    }

    /**
     * Full relay of an offerless re-INVITE: the other leg is re-INVITEd without SDP, its 2xx offer is returned to
     * the requester, and the requester's ACK answer is delivered as the other leg's ACK body. Every wait is bounded.
     */
    private async relayOfferlessModify(call: ActiveCall, dialog: NativeDialog, peer: NativeDialog, req: IncomingSipRequest, res: SipResponse) {
        let peerOffer: string | undefined;
        let peerAck: Promise<void> | undefined;
        let answeredAt = Date.now();
        // Single ACK for the peer's late-offer 2xx, whatever path reaches it first (I6). Later callers share its outcome;
        // the obligation is cleared only once the ACK succeeded, and a definitely refused ACK may be sent again.
        const ackPeer = (sdp: string) => {
            if (peerAck) return peerAck;
            let sending!: Promise<void>;
            sending = (async () => {
                try {
                    await peer.ackAnswer(sdp);
                } catch (err) {
                    if (peerAck === sending && !(err instanceof NativeOperationError && err.uncertain)) peerAck = undefined;
                    throw err;
                }
                this.ackOwed.delete(peer);
            })();
            peerAck = sending;
            return sending;
        };
        let waiting = false;
        let respondPending = false;
        let reinvited = false;
        try {
            // I6: the ACK obligation exists from the moment the offerless re-INVITE is on the wire, so a BYE issued
            // meanwhile by any path waits for the 2xx and rejects its offer first.
            // Only a 2xx carrying an SDP body is a late offer: sipbridge already ACKed any other body with an empty ACK.
            const offering = peer.reinviteOffer().then(result => {
                answeredAt = Date.now();
                return result.sdp;
            });
            this.ackOwed.set(peer, {
                settle: async () => {
                    const offer = await offering.catch(() => '');
                    if (offer) await ackPeer(rejectSdpOffer(offer));
                },
                answeredAt: () => answeredAt
            });
            peerOffer = await offering;
            reinvited = true;
            if (!peerOffer) this.ackOwed.delete(peer);
            this.assertLiveCall(call);
            if (!peerOffer) throw new Error('Peer provided no late offer');
            const localOffer = relaySdp(peerOffer, this.legSdp(dialog));
            const ackWait = dialog.awaitPeerAck(req.cseq, this.handoffAckTimeoutMs);
            waiting = true;
            ackWait.catch(() => undefined);
            // The 200 may stall (a native command awaits write confirmation); the ACK deadline must not wait for it, so
            // the cleanup below runs as soon as either fails. While the 200 is in flight no second final response is sent.
            respondPending = true;
            const responding = res
                .respond(200, { body: localOffer, headers: SDP_HEADERS })
                .catch(err => {
                    dialog.cancelPeerAckWait(req.cseq);
                    throw err;
                })
                .finally(() => {
                    respondPending = false;
                });
            responding.catch(() => undefined);
            // The requester's ACK proves the 200 was delivered, so the peer's ACK must not wait for the 200 receipt to settle
            // (the peer's own ACK timer is shorter than the command budget).
            await Promise.race([responding, ackWait]);
            const ackBody = await ackWait;
            this.assertLiveCall(call);
            if (!ackBody) throw new Error('Missing SDP answer in ACK');
            const peerAnswer = relaySdp(ackBody, this.legSdp(peer));
            await ackPeer(peerAnswer);
            this.sentSdp.set(dialog, localOffer);
            this.sentSdp.set(peer, peerAnswer);
            this.recordCarrierSdp(call, dialog, localOffer, ackBody);
            if (peer === call.dialog) this.updateCallSdp(call, { localSdp: peerAnswer, remoteSdp: peerOffer });
        } catch (err) {
            this.logger.warn({ callId: call.callId, failure: 'paired-offerless-relay-failed', ackWait: waiting }, errorMessage(err));
            if (!reinvited) {
                // The peer refused the offerless re-INVITE (glare, 488, ...): nothing changed on either leg.
                this.ackOwed.delete(peer);
                if (!res.finalResponseSent) await res.respond(isGlare(err) ? 491 : 488).catch(() => undefined);
                if (this.peerOutcomeUnknown(err, peer)) await this.endUncertainPair(call);
                else this.endIfDialogGone(call, err);
                return;
            }
            if (peerOffer && !peerAck && !peer.isFenced && !peer.isEnded) {
                try {
                    await ackPeer(rejectSdpOffer(peerOffer));
                } catch {
                    // A peer whose ACK failed is still ended by the BYE below (an uncertain one is fenced and never commanded).
                }
            }
            if (!res.finalResponseSent && !respondPending) await res.respond(488).catch(() => undefined);
            // The peer's offer was rejected (or never answered): the legs no longer agree on media, so end the call.
            await this.byeCall(call, 'renegotiation-failed').catch(() => undefined);
        }
    }

    private async handleRefer(call: ActiveCall, dialog: NativeDialog, req: IncomingSipRequest, res: SipResponse) {
        // Only a return on a handed-off call is supported; an application-owned call never accepted REFER.
        if (call.ownership === 'application') {
            await res.respond(405);
            return;
        }
        let uri: string;
        try {
            const referTo = [...headerValues(req, 'refer-to'), ...headerValues(req, 'r')];
            if (referTo.length !== 1) throw new Error('Expected exactly one Refer-To');
            const target = parseReferTarget(referTo[0]);
            uri = target.uri;
            if (target.replaces) {
                const match = this.registry.findDialog(target.replaces);
                if (!match || match.call !== call || target.replaces.earlyOnly) {
                    await res.respond(481);
                    return;
                }
            }
        } catch {
            await res.respond(400);
            return;
        }
        const destinationUri = stripSipUri(uri);
        if (!acceptsSipHost(destinationUri, this.config.SIP_ALLOWED_DOMAINS)) {
            await res.respond(404);
            return;
        }
        const routeDestination = { destinationUri, destinationUser: getSipUser(destinationUri) };
        const controlRoute = this.controlHub?.findRoute(routeDestination);
        const httpRoute = matchRoute(this.config.ROUTES, routeDestination);
        if (!controlRoute && !httpRoute) {
            await res.respond(404);
            return;
        }
        if (call.ownership === 'transferring' || call.ownership === 'returning' || this.modifyingPairs.has(call)) {
            await res.respond(491);
            return;
        }
        // RFC 6665 4.2.2: a failure response to a NOTIFY ends the implicit REFER subscription, so no later NOTIFY is sent.
        // RFC 4488: suppression is only in effect when the 202 echoes `Refer-Sub: false`; otherwise NOTIFYs must be sent.
        const suppressNotify = readHeader(req, 'refer-sub')?.split(';')[0].trim().toLowerCase() === 'false';
        let subscriptionGone = false;
        let progress: Promise<void> | undefined;
        const notify = async (status: number, final: boolean) => {
            if (final) await progress?.catch(() => undefined);
            if (subscriptionGone || suppressNotify || dialog.isFenced || dialog.isEnded) return;
            const sequence = req.cseq || undefined;
            const send = () =>
                dialog.request('NOTIFY', {
                    headers: {
                        Event: sequence ? `refer;id=${sequence}` : 'refer',
                        'Subscription-State': final ? 'terminated;reason=noresource' : 'active;expires=60',
                        'Content-Type': 'message/sipfrag'
                    },
                    body: `SIP/2.0 ${status} ${status === 200 ? 'OK' : status === 100 ? 'Trying' : 'Return Failed'}\r\n`
                });
            // The final NOTIFY tells the referrer the outcome and ends the subscription: a definite LOCAL refusal (nothing
            // was sent: e.g. native command slots full) is retried on the bounded schedule while the dialog is usable. A
            // peer final, a timeout and an uncertain outcome are never retried.
            await (final ? this.retryDefinite(dialog, send, isLocalRefusal) : send())
                // A 481 to a NOTIFY ends only the implicit REFER subscription (RFC 6665), never the INVITE dialog.
                .catch(err => {
                    // A peer final (non-2xx, or a timeout arriving as a COMPLETED error with status 0) ends it (RFC 6665);
                    // so does an uncertain outcome. A local refusal is not the peer's answer and leaves it intact.
                    if (err instanceof NativeOperationError && (err.sipStatus >= 300 || err.uncertain || err.completed)) subscriptionGone = true;
                });
        };
        const returning = call.ownership === 'handed-off';
        // I1: the return claim is synchronous with the ownership check above.
        if (returning) {
            call.ownership = 'returning';
            this.modifyingPairs.add(call);
        }
        try {
            await res.respond(202, suppressNotify ? { headers: { 'Refer-Sub': 'false' } } : undefined);
        } catch (err) {
            if (returning) {
                // An UNKNOWN 202 fences the referring leg (I5): the pair cannot be kept, so the call ends. bye() takes the
                // registry token first, never commands the fenced leg, BYEs the usable one and reports termination once.
                if (dialog.isFenced && this.registry.get(call.callId) === call) {
                    this.modifyingPairs.delete(call);
                    this.logger.warn(
                        { callId: call.callId, failure: 'return-refer-response-uncertain' },
                        'REFER response outcome unknown; ending call'
                    );
                    await this.byeCall(call, 'return-refer-uncertain').catch(() => undefined);
                    return;
                }
                this.modifyingPairs.delete(call);
                if (this.registry.get(call.callId) === call) {
                    if (call.peerDialog && !call.peerDialog.isEnded) {
                        call.ownership = 'handed-off';
                        // Fences are not acted on while returning: a pair with an uncertain leg cannot be kept.
                        if (this.pairHasFencedLeg(call)) await this.byeCall(call, 'return-peer-uncertain').catch(() => undefined);
                    } else {
                        // The destination hung up while the 202 was pending (it was detached as a blind transfer): nobody is
                        // left on the external leg, so the carrier is ended (once) instead of stranded on direct media.
                        this.logger.warn(
                            { callId: call.callId, failure: 'return-refer-refused-no-peer' },
                            'REFER refused and peer gone; ending call'
                        );
                        await this.byeCall(call, 'return-failed-no-peer').catch(() => undefined);
                    }
                }
            }
            throw err;
        }
        progress = notify(100, false);
        try {
            await this.returnToApplication(call, notify, dialog, destinationUri, routeDestination.destinationUser, controlRoute, httpRoute);
        } finally {
            if (!this.retainedPairLocks.has(call)) this.modifyingPairs.delete(call);
        }
    }

    /**
     * Whether the owner selected for a return still wins the route: a control connection must still hold it, and an HTTP
     * route owner only wins while no control connection has registered a matching route (control takes precedence).
     */
    private routeOwnerHolds(
        destination: { destinationUri: string; destinationUser: string | undefined },
        controlRoute: ReturnType<ControlHub['findRoute']>,
        httpRoute: ReturnType<typeof matchRoute>
    ): boolean {
        if (controlRoute) return !!this.controlHub?.holdsRoute(controlRoute.connectionId, destination);
        if (this.controlHub?.findRoute(destination)) return false;
        return !!httpRoute && matchRoute(this.config.ROUTES, destination)?.url === httpRoute.url;
    }

    private async returnToApplication(
        call: ActiveCall,
        notify: (status: number, final: boolean) => Promise<void>,
        referrer: NativeDialog,
        destinationUri: string,
        destinationUser: string | undefined,
        initialControlRoute: ReturnType<ControlHub['findRoute']>,
        initialHttpRoute: ReturnType<typeof matchRoute>
    ) {
        let controlRoute = initialControlRoute;
        let httpRoute = initialHttpRoute;
        let preparedCall: ActiveCall | undefined;
        const previousSdp = call.localSdp;
        const previousRemoteSdp = this.syncRemoteSdp(call);
        let switched = false;
        let localSdp = '';
        let releaseMedia = () => {};
        // Unique per return attempt: echoed on this attempt's answered and terminated events.
        const returnAttemptId = randomUUID();
        // Only a referrer that is the retained carrier can be fenced by its own final NOTIFY in a way that decides the kept
        // leg; for the destination (being retired) nothing waits on the NOTIFY retries.
        const keptReferrer = referrer === call.dialog;
        // The prepared owner's correlated outcome for this attempt (never sent once sip.answered went out).
        // return-failed (the call continues) is held in the same synchronous step as its liveness check, before the POST chain
        // starts: a later call-level end event to the same HTTP owner waits for this bounded POST. SIP teardown never waits on
        // it. return-aborted follows the call's own end event and never holds.
        const sendAttemptTerminated = (reason: 'return-aborted' | 'return-failed') => {
            if (!preparedCall) return;
            const owner = preparedCall;
            // The call's own end event settles first (success or failure; each POST is bounded by the callback timeout), so
            // an HTTP owner never receives return-aborted before it.
            const callEnd = this.terminatedDeliveries.get(call) ?? Promise.resolve();
            let releaseHold = () => {};
            // Only the same HTTP owner's ordering matters: a WS-owned call or one owned by another receiver is never delayed.
            if (
                reason === 'return-failed' &&
                this.registry.get(call.callId) === call &&
                !(call.controlConnectionId && this.controlHub?.isConnected(call.controlConnectionId)) &&
                !(preparedCall.controlConnectionId && this.controlHub?.isConnected(preparedCall.controlConnectionId)) &&
                call.receiverUrl === preparedCall.receiverUrl
            ) {
                const hold = Promise.withResolvers<void>();
                releaseHold = () => hold.resolve();
                this.trackAnsweredDelivery(call, hold.promise);
            }
            void callEnd
                .catch(() => undefined)
                .then(() =>
                    this.sendFollowUpEvent(owner, {
                        event: 'terminated',
                        callId: call.callId,
                        sipCallId: call.sipCallId,
                        reason,
                        returnAttemptId,
                        receivedAt: new Date().toISOString()
                    })
                )
                .finally(() => releaseHold());
        };
        try {
            const offer = previousRemoteSdp;
            if (!offer) throw new InvalidCallStateError('Caller has no media description');
            // The 202 await let the carrier hang up (the end handler already removed the call and told its owner sip.bye):
            // a dead call is never offered to the application, so it can never see an invite after a bye.
            this.assertLiveCall(call);
            if (call.dialog.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
            const routeDestination = { destinationUri, destinationUser };
            // Settled BEFORE the route is chosen: a WebSocket owner may register the route while the previous HTTP owner's
            // transferred POST is in flight, and the stale owner must then never see the return invite.
            await this.settlePendingOwnerDeliveries(call);
            // The settle wait let the carrier hang up or be fenced: the claim is revalidated before anything is sent.
            this.assertLiveCall(call);
            if (call.dialog.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
            if (call.ownership !== 'returning') throw new InvalidCallStateError('Return claim lost during owner settle');
            controlRoute = this.controlHub?.findRoute(routeDestination);
            httpRoute = matchRoute(this.config.ROUTES, routeDestination);
            if (!controlRoute && !httpRoute) throw new InvalidCallStateError('No application route for return');
            const invite: InviteHttpRequest = {
                event: 'invite',
                callId: call.callId,
                sipCallId: call.sipCallId,
                logicalCallId: call.logicalCallId,
                returning: true,
                previousSessionId: call.callId,
                returnAttemptId,
                destinationUri,
                destinationUser,
                sourceUri: call.sourceUri,
                headers: {},
                sdp: offer,
                receivedAt: new Date().toISOString()
            };
            const action = controlRoute
                ? await this.requestInviteActionFromControl(controlRoute.connectionId, invite)
                : await this.requestInviteActionFromHttp(httpRoute!.url, invite);
            if (action.action === 'reject') throw new InvalidCallStateError('Application cannot accept return');
            preparedCall = {
                ...call,
                peerDialog: undefined,
                controlConnectionId: controlRoute?.connectionId,
                routeUrl: controlRoute?.route.url ?? httpRoute!.url,
                receiverUrl: controlRoute?.route.url ?? action.receiverUrl ?? httpRoute!.url
            };
            this.assertLiveCall(call);
            if (!this.routeOwnerHolds(routeDestination, controlRoute, httpRoute))
                throw new InvalidCallStateError('Return owner no longer holds the route');
            if (call.dialog.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
            this.assertMediaUnreserved(action.sdp, call);
            localSdp = relaySdp(action.sdp, this.legSdp(call.dialog));
            releaseMedia = this.claimLocalMedia(localSdp, call);
            const answer = await call.dialog.reinvite(localSdp);
            // Only an accepted re-INVITE changed the carrier's media; a refused one needs no restore.
            switched = true;
            this.sentSdp.set(call.dialog, localSdp);
            // A 200 that rejects audio is not a successful return: restore through the failure path below.
            assertDirectMediaAnswer(localSdp, answer);
            this.assertLiveCall(call);
            if (!this.routeOwnerHolds(routeDestination, controlRoute, httpRoute))
                throw new InvalidCallStateError('Return owner no longer holds the route');
            // A fenced carrier (the leg being kept) blocks the commit and takes the fenced-carrier path below. A fenced
            // destination is being retired anyway: it only cannot be BYEd (byeLeg skips it).
            if (call.dialog.isFenced) throw new NativeOperationError('Native signaling outcome unknown', true);
            // Commit synchronously; the old destination leg is detached before it is ended (I4).
            const oldPeer = call.peerDialog;
            call.peerDialog = undefined;
            call.peerAddress = undefined;
            call.peerHost = undefined;
            call.peerAddresses = undefined;
            call.controlConnectionId = preparedCall.controlConnectionId;
            call.receiverUrl = preparedCall.receiverUrl;
            call.routeUrl = preparedCall.routeUrl;
            call.destinationUri = destinationUri;
            call.destinationUser = destinationUser;
            call.ownership = 'application';
            this.updateCallSdp(call, { localSdp, remoteSdp: answer });
            const sendAnswered = () =>
                void this.sendFollowUpEvent(call, {
                    event: 'answered',
                    callId: call.callId,
                    sipCallId: call.sipCallId,
                    sdp: localSdp,
                    returnAttemptId,
                    receivedAt: new Date().toISOString()
                });
            if (!keptReferrer) {
                // The destination referred: its NOTIFY cannot fence the kept carrier, so the owner hears answered now and the
                // NOTIFY retries and the old-peer BYE (after the NOTIFY) run in the background.
                sendAnswered();
                void this.runBackground('return-notify-failed', call.callId, async () => {
                    await notify(200, true);
                    if (oldPeer) await this.byeLeg(oldPeer);
                });
                return;
            }
            await notify(200, true);
            if (oldPeer) void this.byeLeg(oldPeer).catch(() => undefined);
            // The wait for the final NOTIFY let the retained leg hang up or be fenced: the owner must never see answered
            // after bye. A carrier fenced by an UNKNOWN final NOTIFY cannot be kept, so the call ends (no answered). Either
            // way the attempt ended without sip.answered, so its owner is told after the call's own end event.
            if (this.registry.get(call.callId) !== call) {
                sendAttemptTerminated('return-aborted');
                return;
            }
            if (call.dialog.isFenced || call.dialog.isEnded) {
                const removed = this.registry.remove(call.callId);
                if (removed) {
                    this.cancelTransferForCall(call);
                    this.sendTerminated(removed, call.dialog.isFenced ? 'return-carrier-uncertain' : 'return-carrier-ended', {});
                }
                sendAttemptTerminated('return-aborted');
                return;
            }
            sendAnswered();
        } catch (err) {
            this.logger.warn({ callId: call.callId, failure: 'return-failed' }, errorMessage(err));
            // A fenced carrier (UNKNOWN re-INVITE outcome) may already be on application media while the destination is
            // still connected to it: the call cannot be recovered. The registry token is taken before any await (I7);
            // the fenced carrier is never commanded (I5), the destination is ended after the final NOTIFY.
            if (this.registry.get(call.callId) === call && call.ownership === 'returning' && call.dialog.isFenced) {
                const removed = this.registry.remove(call.callId)!;
                const oldPeer = removed.peerDialog;
                removed.peerDialog = undefined;
                // The call's own end is always reported (to the call's owner) before the attempt's outcome.
                this.sendTerminated(removed, 'return-carrier-uncertain', {});
                // The call ended: the attempt is aborted whoever owns it.
                sendAttemptTerminated('return-aborted');
                const finish = async () => {
                    await notify(503, true);
                    if (oldPeer)
                        await this.byeLeg(oldPeer).catch(() =>
                            this.logger.warn(
                                { callId: call.callId, failure: 'return-peer-bye-failed' },
                                'Failed to terminate destination after failed return'
                            )
                        );
                };
                if (keptReferrer) await finish();
                else void this.runBackground('return-notify-failed', call.callId, finish);
                return;
            }
            // The carrier reported its dialog gone (481) while the destination referred: the call is over. The registry token is
            // taken now (I1/I7), before the final NOTIFY is awaited, so no Replaces/REFER/transfer can claim the pair meanwhile;
            // the NOTIFY, the leg BYEs and the owner's events follow in the background task below.
            let goneLegs: NativeDialog[] | undefined;
            let goneCall: ActiveCall | undefined;
            if (
                !keptReferrer &&
                !switched &&
                err instanceof NativeOperationError &&
                err.dialogGone &&
                this.registry.get(call.callId) === call &&
                !call.dialog.isFenced
            ) {
                goneCall = this.registry.remove(call.callId);
                if (goneCall) {
                    this.logger.warn({ callId: call.callId, sipStatus: err.sipStatus }, 'SIP dialog reported gone; ending call');
                    this.cancelTransferForCall(call);
                    goneLegs = [goneCall.dialog, ...(goneCall.peerDialog ? [goneCall.peerDialog] : [])];
                    goneCall.peerDialog = undefined;
                }
            }
            // A carrier known ended (its terminal event is still pending) cannot be restored or kept: end the pair now.
            if (this.registry.get(call.callId) === call && call.ownership === 'returning' && call.dialog.isEnded && !call.dialog.isFenced) {
                await this.byeCall(call, 'return-carrier-ended').catch(() => undefined);
            }
            if (switched && previousSdp && this.registry.get(call.callId) === call && !call.dialog.isFenced && !call.dialog.isEnded) {
                try {
                    const restored = relaySdp(previousSdp, localSdp);
                    this.sentSdp.set(call.dialog, restored);
                    const answer = await this.restoreReinvite(call.dialog, restored);
                    // The destination still sends to the carrier's previous media address: a rejected audio stream or a
                    // moved address leaves one-way audio, so the call ends. Extra formats are legal (RFC 3264 6.1).
                    // The destination still holds its earlier answer: the restored one must share a real voice codec with it.
                    assertRollbackAnswer(answer, previousRemoteSdp!, restored);
                    this.updateCallSdp(call, { localSdp: restored, remoteSdp: answer });
                } catch {
                    await this.byeCall(call, 'return-restore-failed').catch(() => undefined);
                }
            }
            if (this.registry.get(call.callId) === call && call.ownership === 'returning') {
                if (call.peerDialog) call.ownership = 'handed-off';
                // The external party already hung up: the conversation cannot be left working.
                else await this.byeCall(call, 'return-failed-no-peer').catch(() => undefined);
            }
            // The final NOTIFY is queued before any dialog-gone BYE below (both branches run endIfDialogGone after it; it waits
            // only for the progress NOTIFY).
            const finalNotify = async () => {
                await notify(503, true);
                // An UNKNOWN NOTIFY (or progress NOTIFY) fenced a leg of the restored pair: it can never be commanded again
                // (I5), so every later re-INVITE would be refused. End the call; bye() BYEs only the usable leg.
                if (
                    this.registry.get(call.callId) === call &&
                    call.ownership === 'handed-off' &&
                    (call.peerDialog?.isFenced || call.dialog.isFenced)
                ) {
                    await this.byeCall(call, 'return-peer-uncertain').catch(() => undefined);
                }
            };
            // An owner that answered the return invite (preparedCall is only set then) may have allocated media for it, even
            // when the call already ended and the owner was told sip.bye: it always hears a correlated terminated for the
            // return attempt, after the call's own end event. 'return-aborted' when the call ended (whoever owns the
            // attempt), 'return-failed' when the call continues. An owner never offered the return hears nothing.
            const sendOutcome = () => sendAttemptTerminated(this.registry.get(call.callId) !== call ? 'return-aborted' : 'return-failed');
            if (keptReferrer) {
                await finalNotify();
                // A no-op when an earlier path already ended the call.
                if (!switched) this.endIfDialogGone(call, err);
                sendOutcome();
            } else {
                // The kept leg is not the referrer: the pair lock does not wait on NOTIFY retries, so they run detached. The
                // dialog-gone BYE (which ends the referrer too) and the owner's events follow the final NOTIFY inside the same
                // task: the NOTIFY is queued before the BYE, and the call's end event still precedes return-aborted.
                // A referrer that stays attached on the restored pair keeps the pair lock until the final NOTIFY settles, so no
                // cross-leg relay can queue its ACK behind the NOTIFY on the referrer's FIFO (re-INVITEs meanwhile get 491).
                const retainLock =
                    this.registry.get(call.callId) === call && call.ownership === 'handed-off' && !referrer.isEnded && !referrer.isFenced;
                if (retainLock) this.retainedPairLocks.add(call);
                void this.runBackground('return-notify-failed', call.callId, async () => {
                    try {
                        await finalNotify();
                    } finally {
                        if (retainLock) {
                            this.retainedPairLocks.delete(call);
                            this.modifyingPairs.delete(call);
                        }
                        if (goneCall && goneLegs) {
                            // NOTIFY first (above), then the end event (published before the BYEs are awaited, as bye() does),
                            // then the legs (I6 via byeLeg), then the attempt's return-aborted.
                            this.sendTerminated(goneCall, 'dialog-gone', {});
                            await Promise.allSettled(
                                goneLegs.map(leg =>
                                    this.byeLeg(leg).catch(() =>
                                        this.logger.warn({ callId: call.callId, failure: 'dialog-gone-bye-failed' }, 'Failed to terminate SIP dialog')
                                    )
                                )
                            );
                        } else if (!switched) this.endIfDialogGone(call, err);
                        sendOutcome();
                    }
                });
            }
        } finally {
            releaseMedia();
        }
    }

    /** Registers a bounded owner delivery that call-level end events (bye/terminated) wait behind; SIP cleanup never waits. */
    private trackAnsweredDelivery(call: ActiveCall, delivery: Promise<unknown>) {
        const prior = this.answeredDeliveries.get(call);
        const tracked = Promise.all([prior, delivery.catch(() => undefined)]).then(() => undefined);
        this.answeredDeliveries.set(call, tracked);
        void tracked.then(() => {
            if (this.answeredDeliveries.get(call) === tracked) this.answeredDeliveries.delete(call);
        });
    }

    private async handleRemoteModify(callId: string, req: IncomingSipRequest, res: SipResponse) {
        const call = this.registry.get(callId);
        if (!call) {
            await res.respond(481);
            return;
        }
        if ((call.ownership && call.ownership !== 'application') || this.modifyingPairs.has(call)) {
            await res.respond(491);
            return;
        }
        // Only an application/sdp body is an offer: anything else is refused before the application is consulted.
        if (req.body && !incomingCarriesSdp(req)) {
            await res.respond(415, { headers: { Accept: 'application/sdp' } });
            return;
        }

        this.modifyingPairs.add(call);
        let releaseMedia = () => {};
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

            this.assertMediaUnreserved(action.sdp, call);
            // Claimed before the answer is written: a transfer of another call must not destroy this endpoint meanwhile.
            releaseMedia = this.claimLocalMedia(action.sdp, call);
            await res.respond(action.status ?? 200, { body: action.sdp, headers: action.headers });
            this.updateCallSdp(call, { localSdp: action.sdp, remoteSdp: req.body });
        } catch (err) {
            this.logger.warn({ failure: 'signaling-or-owner-operation-failed', callId }, 'Receiver failed to handle remote re-INVITE');
            await res.respond(sipStatusForError(err));
        } finally {
            releaseMedia();
            this.modifyingPairs.delete(call);
        }
    }

    /** An HTTP return invite never overtakes the call's in-flight answered/transferred POSTs (each bounded by the callback deadline). */
    private async settlePendingOwnerDeliveries(call: ActiveCall) {
        const pending = this.answeredDeliveries.get(call);
        if (pending) await pending.catch(() => undefined);
    }

    private sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction: true): Promise<SipAction>;
    private sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: false): Promise<void>;
    private async sendFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: boolean): Promise<SipAction | void> {
        if (
            !expectAction &&
            (event.event === 'answered' || event.event === 'transferred') &&
            !(call.controlConnectionId && this.controlHub?.isConnected(call.controlConnectionId))
        ) {
            // An HTTP owner's answered/transferred POST can still be in flight when the call ends; the call-level end event
            // queues behind it (bounded by the callback deadline) so the owner never sees bye before it. SIP cleanup never waits.
            const delivery = this.dispatchFollowUpEvent(call, event, expectAction);
            this.trackAnsweredDelivery(call, delivery);
            return delivery;
        }
        if (!expectAction && (event.event === 'bye' || event.event === 'terminated') && !event.returnAttemptId) {
            const answered = this.answeredDeliveries.get(call);
            if (answered) await answered;
        }
        return this.dispatchFollowUpEvent(call, event, expectAction);
    }

    private async dispatchFollowUpEvent(call: ActiveCall, event: FollowUpHttpEvent, expectAction?: boolean): Promise<SipAction | void> {
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
            await this.httpClient.postJson<unknown>(call.receiverUrl, event, this.config.EVENT_HTTP_TIMEOUT_MS, { discardBody: true });
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
            await this.httpClient.postJson(receiverUrl, event, this.config.EVENT_HTTP_TIMEOUT_MS, { discardBody: true });
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

/** A NativeOperationError that is definitely not an accepted command: retryable while the leg is still commandable. */
/** A refusal that sent nothing on the wire: not uncertain, not a peer's (or timed-out) final response. */
function isLocalRefusal(err: unknown, dialog: NativeDialog) {
    return isDefiniteRefusal(err, dialog) && !(err as NativeOperationError).completed && (err as NativeOperationError).sipStatus < 300;
}

function isDefiniteRefusal(err: unknown, dialog: NativeDialog) {
    return err instanceof NativeOperationError && !err.uncertain && !dialog.isEnded && !dialog.isFenced;
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

/** Glare: the peer answered 491, or sipbridge refused locally because an INVITE procedure is already pending. */
function isGlare(err: unknown) {
    // sipbridge reports both as sipStatus: a peer's 491 final (COMPLETED) and its own 491 refusal (NOT_ACCEPTED).
    return err instanceof NativeOperationError && err.sipStatus === 491;
}

/** RFC 3261 14.1: 2.1-4s when the gateway owns the Call-ID (UAC), else 0-2s. */
function defaultGlareDelayMs(originated: boolean) {
    return originated ? 2100 + Math.random() * 1900 : Math.random() * 2000;
}

/**
 * A restore refusal that is safe to repeat: a definite local refusal (nothing was sent, including local capacity), or
 * the peer's completed 491. Never an uncertain outcome, another peer final, or an ended/fenced leg.
 */
function isRetryableRestoreRefusal(err: unknown, dialog: NativeDialog) {
    if (!isDefiniteRefusal(err, dialog)) return false;
    const e = err as NativeOperationError;
    return !e.completed || e.sipStatus === 491;
}

/** Canonical numeric form (equivalent IPv6 spellings and mapped IPv4 compare equal); non-IP input is only lowercased. */
function normalizeIp(address: string) {
    const bare = address.trim().replace(/^\[|\]$/g, '');
    return sourceIp(bare) ?? bare.toLowerCase();
}

/** Host part of a SIP URI or proxy value (`sip:user@host:port;params`, `host:port`). */
function uriHost(value: string | undefined) {
    if (!value) return undefined;
    const match = /^(?:sips?:)?(?:[^@/;?]*@)?(\[[^\]]+\]|[^:;?>\s]+)/i.exec(value.trim());
    return match?.[1].replace(/^\[|\]$/g, '');
}

/** Resolved addresses, or undefined when resolution failed (which is not evidence about the source). */
async function resolveHost(host: string): Promise<string[] | undefined> {
    if (isIP(host)) return [host];
    try {
        return (await lookup(host, { all: true })).map(entry => entry.address);
    } catch {
        return undefined;
    }
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

/** sipbridge's SDP rule applied to an incoming request: exactly one Content-Type whose media type is application/sdp. */
function incomingCarriesSdp(req: Pick<IncomingSipRequest, 'body' | 'headers'> & Partial<Pick<IncomingSipRequest, 'getAll'>>) {
    const types = [...headerValues(req, 'content-type'), ...headerValues(req, 'c')];
    return messageCarriesSdp({ body: Buffer.from(req.body), headers: types.map(value => ({ name: 'content-type', value })) });
}

function readHeaders(req: IncomingSipRequest) {
    const headers: SipHeaders = {};
    for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (typeof value === 'string') headers[key] = value;
    }
    return headers;
}

function readHeaderRaw(req: Pick<IncomingSipRequest, 'get' | 'headers'>, name: string) {
    try {
        return req.get(name) ?? req.headers?.[name.toLowerCase()];
    } catch {
        return req.headers?.[name.toLowerCase()];
    }
}

/** Number of Replaces header field instances on the request (the header map keeps only the last one). */
function replacesInstances(req: Pick<IncomingSipRequest, 'headers'> & Partial<Pick<IncomingSipRequest, 'getAll'>>) {
    return req.getAll ? req.getAll('replaces').length : req.headers?.['replaces'] !== undefined ? 1 : 0;
}

/** Every instance of a header (case-insensitive), from the request's getAll when available, else the header map. */
function headerValues(req: Pick<IncomingSipRequest, 'headers'> & Partial<Pick<IncomingSipRequest, 'getAll'>>, name: string): string[] {
    try {
        const all = req.getAll?.(name);
        if (all?.length) return all.map(String);
    } catch {
        // Fall back to the header map.
    }
    const found: string[] = [];
    for (const [key, value] of Object.entries(req.headers ?? {})) {
        if (key.toLowerCase() === name && typeof value === 'string') found.push(value);
    }
    return found;
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
    // The application bound media that is reserved by a handoff in progress.
    if (err instanceof SipOperationConflictError) return 488;
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
