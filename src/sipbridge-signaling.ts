import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { FileRtcEndpointCatalog, type SignalingBackend } from './endpoint-catalog';
import type { GatewayConfig } from './config';
import { SipbridgeControlClient, SipbridgeControlNotSentError } from './sipbridge/client';
import {
    SIPBRIDGE_CAPABILITY,
    SIPBRIDGE_STATE_CAPABILITY,
    SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY,
    SIPBRIDGE_COMMAND_ADMISSION_CAPABILITY,
    SIPBRIDGE_COMMAND_BUDGET_CAPABILITY,
    SIPBRIDGE_CONTINUITY_CAPABILITY,
    SIPBRIDGE_REQUEST_DECISION_CAPABILITY,
    SIPBRIDGE_REINVITE_ACK_CAPABILITY
} from './sipbridge/codec';
import {
    Command,
    ContextSnapshot,
    ContextRetirementProof_Reason,
    DialogEvent,
    DialogEvent_Kind,
    OperationResult_Certainty,
    OwnerIngest_Admission,
    type ContextRef,
    type Envelope,
    type FlowRef,
    type ProcessRef,
    RequestPresented,
    type RequestDecision,
    type SipMessage
} from './sipbridge/generated/sipbridge-control';
import type { OutboundSipCallParams } from './sip-gateway';

const capabilities = [
    SIPBRIDGE_CAPABILITY,
    SIPBRIDGE_STATE_CAPABILITY,
    SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY,
    SIPBRIDGE_COMMAND_ADMISSION_CAPABILITY,
    SIPBRIDGE_COMMAND_BUDGET_CAPABILITY,
    SIPBRIDGE_CONTINUITY_CAPABILITY,
    SIPBRIDGE_REQUEST_DECISION_CAPABILITY,
    SIPBRIDGE_REINVITE_ACK_CAPABILITY
];
// Methods present() always answers for a first request, and methods valid only inside a dialog.
const ANSWERED_FIRST_METHODS = ['INVITE', 'OPTIONS'];
const DIALOG_ONLY_METHODS = ['BYE', 'ACK', 'CANCEL', 'INFO', 'UPDATE', 'PRACK', 'REFER'];
// In-dialog requests presented to the application dialog; everything else keeps its native default.
const DIALOG_REQUEST_METHODS = ['INVITE', 'UPDATE', 'REFER'];
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, REFER';
// Upper bound on waiting for a peer's ACK that completes a relayed offerless re-INVITE.
export const PEER_ACK_WAIT_MS = 10_000;
const MAX_BUFFERED_ACKS = 8;
const MAX_CONTEXTS = 1024;
const MAX_RECEIPTS = 8192;
// sipbridge redelivers an unacknowledged lifecycle event for about two minutes.
const RECEIPT_LIFETIME_MS = 150_000;
const UNCERTAIN_FIRST_REQUEST_MS = 40_000;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const processEqual = (a?: ProcessRef, b?: ProcessRef) => a?.instanceId === b?.instanceId && a?.epoch === b?.epoch;
const contextKey = (ref: ContextRef) => JSON.stringify([ref.state?.authority, ref.state?.groupId, ref.state?.incarnation, ref.id]);
const emptyResult = () => ({
    certainty: OperationResult_Certainty.ACCEPTED,
    error: '',
    sipStatus: 0
});
export class NativeOperationError extends Error {
    constructor(
        message: string,
        readonly uncertain = false,
        readonly unavailable = false,
        /** The peer's SIP final status when known (0 = none/unknown). */
        readonly sipStatus = 0,
        /**
         * RFC 3261 14.1 / RFC 5057: the peer (or silence from it) established that the dialog no longer exists.
         * Never set for a local refusal.
         */
        readonly dialogGone = false
    ) {
        super(message);
    }
}
export interface IncomingSipRequest {
    method: string;
    uri: string;
    callId: string;
    body: string;
    /** CSeq number of the request (0 when absent or malformed). */
    cseq: number;
    headers: Record<string, string>;
    /** Source observed by sipbridge for this request; absent when the flow is unknown. */
    source?: SipSource;
    get(name: string): string | undefined;
}
export interface SipSource {
    ip: string;
    port: number;
    transport: string;
}
/** Returns true when the observed source is banned. */
export type BanPolicy = (source: SipSource | undefined) => boolean;
/** Route admission for a fresh request that survived every other check: a SIP status to deny with, or undefined to admit. */
export type RoutePolicy = (message: SipMessage, source: SipSource | undefined) => number | undefined;
export interface SipResponse {
    finalResponseSent: boolean;
    respond(status: number, options?: { body?: string; headers?: Record<string, string> }): Promise<void>;
    answer(sdp: string, headers?: Record<string, string>): Promise<NativeDialog>;
}
interface Peer {
    endpoint: SignalingBackend;
    client?: SipbridgeControlClient;
    connecting: boolean;
    reconciled?: boolean;
    retryAt: number;
    delay: number;
}
interface Context {
    peer: Peer;
    snapshot: ContextSnapshot;
    sequence: bigint;
    tail: Promise<unknown>;
    uncertain: boolean;
    dialog?: NativeDialog;
    deferred?: ReturnType<typeof Promise.withResolvers<NativeDialog>>;
    credentials?: { id: string };
    ended: boolean;
    retiredAt?: number;
    pendingCommands?: number;
    /** First-request context that has not become a dialog; bounded if its outcome is uncertain. */
    first?: boolean;
    expiresAt?: number;
    onProvisional?: (status: number) => void;
    /** Source of the first request of an inbound context; sipbridge reports no delivery flow in snapshots or for outbound contexts. */
    peerSource?: SipSource;
}
function sourceOf(request: RequestPresented): SipSource | undefined {
    const flow = request.flow;
    return flow?.sourceIp ? { ip: flow.sourceIp, port: flow.sourcePort, transport: flow.transport } : undefined;
}
export class NativeDialog extends EventEmitter {
    constructor(
        readonly state: Context,
        private owner: SipbridgeSignaling
    ) {
        super();
        this.setMaxListeners(0);
        this.once('ended', () => {
            for (const [cseq, waiter] of this.ackWaiters) {
                clearTimeout(waiter.timer);
                this.ackWaiters.delete(cseq);
                waiter.reject(new NativeOperationError('Dialog ended while waiting for ACK'));
            }
        });
    }
    private attached = Promise.withResolvers<void>();
    private ackWaiters = new Map<number, { resolve: (body: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private bufferedAcks = new Map<number, string>();
    activate() {
        this.attached.resolve();
    }
    get applicationAttached() {
        return this.attached.promise;
    }
    get isEnded() {
        return this.state.ended;
    }
    /** True after an uncertain outcome: no further command may be sent, not even BYE. */
    get isFenced() {
        return this.state.uncertain;
    }
    get sipCallId() {
        return this.state.snapshot.callId;
    }
    /** Tag of this side of the dialog (To tag for inbound, From tag for outbound). */
    get localTag() {
        return this.state.snapshot.localTag;
    }
    get remoteTag() {
        return this.state.snapshot.remoteTag;
    }
    /**
     * Network source sipbridge observed for the peer's initial request. Inbound dialogs only: snapshots carry no
     * delivery flow and outbound (UAC) contexts have no observed source, so this is undefined for them.
     */
    get peerSource(): SipSource | undefined {
        return this.state.peerSource;
    }
    get localSdp() {
        return Buffer.from(this.state.snapshot.localSdp).toString('utf8');
    }
    get remoteSdp() {
        return Buffer.from(this.state.snapshot.remoteSdp).toString('utf8');
    }
    /**
     * Sends a re-INVITE. With an empty body it is offerless: the result is the peer's 2xx offer and the caller
     * must complete the exchange with ackAnswer().
     */
    async reinvite(sdp: string, headers?: Record<string, string>) {
        const snapshot = await this.owner.command(this.state, {
            $case: 'dialogRequest',
            dialogRequest: { method: 'INVITE', body: Buffer.from(sdp), headers: nativeHeaders(headers) }
        });
        return Buffer.from(snapshot.remoteSdp).toString('utf8');
    }
    /** Sends the ACK answer for a late-offer 2xx (an initial late-offer UAC or an offerless re-INVITE we sent). */
    async ackAnswer(sdp: string, headers?: Record<string, string>) {
        await this.owner.command(this.state, {
            $case: 'dialogRequest',
            dialogRequest: { method: 'ACK', body: Buffer.from(sdp), headers: nativeHeaders(headers) }
        });
    }
    /** Sends an in-dialog request (UPDATE, NOTIFY, INFO, ...). */
    async request(method: string, options: { body?: string; headers?: Record<string, string> } = {}) {
        const snapshot = await this.owner.command(this.state, {
            $case: 'dialogRequest',
            dialogRequest: { method, body: Buffer.from(options.body ?? ''), headers: nativeHeaders(options.headers) }
        });
        return Buffer.from(snapshot.remoteSdp).toString('utf8');
    }
    async bye(headers?: Record<string, string>) {
        await this.owner.command(this.state, {
            $case: 'dialogRequest',
            dialogRequest: { method: 'BYE', body: Buffer.alloc(0), headers: nativeHeaders(headers) }
        });
    }
    /** Called by signaling when the peer's ACK to its own re-INVITE (CSeq `inviteCseq`) was accepted natively. */
    deliverAck(inviteCseq: number, body: string) {
        this.emit('ack', { inviteCseq, body });
        const waiter = this.ackWaiters.get(inviteCseq);
        if (waiter) {
            clearTimeout(waiter.timer);
            this.ackWaiters.delete(inviteCseq);
            waiter.resolve(body);
            return;
        }
        this.bufferedAcks.set(inviteCseq, body);
        while (this.bufferedAcks.size > MAX_BUFFERED_ACKS) this.bufferedAcks.delete(this.bufferedAcks.keys().next().value!);
    }
    /**
     * Resolves with the body of the peer's ACK to its re-INVITE `inviteCseq`. Register before answering the
     * re-INVITE; an ACK that already arrived is returned immediately. Rejects after `timeoutMs` or when the dialog ends.
     */
    awaitPeerAck(inviteCseq: number, timeoutMs = PEER_ACK_WAIT_MS): Promise<string> {
        const buffered = this.bufferedAcks.get(inviteCseq);
        if (buffered !== undefined) {
            this.bufferedAcks.delete(inviteCseq);
            return Promise.resolve(buffered);
        }
        if (this.state.ended) return Promise.reject(new NativeOperationError('Dialog ended'));
        if (this.ackWaiters.has(inviteCseq)) return Promise.reject(new Error('ACK wait already registered'));
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ackWaiters.delete(inviteCseq);
                reject(new NativeOperationError('Timed out waiting for peer ACK'));
            }, timeoutMs);
            this.ackWaiters.set(inviteCseq, { resolve, reject, timer });
        });
    }
    /** Abandons a wait registered with awaitPeerAck (e.g. when the 2xx could not be sent). */
    cancelPeerAckWait(inviteCseq: number) {
        const waiter = this.ackWaiters.get(inviteCseq);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.ackWaiters.delete(inviteCseq);
        waiter.reject(new NativeOperationError('ACK wait cancelled'));
    }
}
export interface OutboundAttempt {
    cancel(): Promise<void>;
    /** Observes provisional response statuses; provisional SDP is never exposed. */
    onProvisional?: (status: number) => void;
    completed: Promise<NativeDialog>;
}
/** Application references only. All SIP reducers, transport writes and timers remain native. */
export class SipbridgeSignaling extends EventEmitter {
    readonly process: ProcessRef;
    private readonly peers = new Map<string, Peer>();
    private readonly contexts = new Map<string, Context>();
    private readonly credentials = new Map<string, { peer: Peer; username: string; password: string; context?: string; contextId: string }>();
    private readonly events = new Map<string, { fingerprint: string; expires: number; dispatched?: boolean }>();
    private readonly pendingRequests = new Map<string, Promise<void>>();
    private attempt = 0n;
    private stopped = true;
    private catalog?: FileRtcEndpointCatalog;
    private timer?: NodeJS.Timeout;
    onInvite?: (request: IncomingSipRequest, response: SipResponse) => Promise<void>;
    applicationReady: () => boolean = () => true;
    acceptingIngress: (message: SipMessage) => boolean = () => true;
    /** Banned-source refusal (403); runs for fresh requests right after the unscored 503 check. */
    banPolicy?: BanPolicy;
    /** Route check and scoring (404); runs last, after every protocol refusal. */
    routePolicy?: RoutePolicy;
    isDraining: () => boolean = () => false;
    constructor(private config: GatewayConfig) {
        super();
        this.process = {
            instanceId: config.SIPBRIDGE_INSTANCE_ID ?? 'rtc-' + randomUUID(),
            epoch: randomUUID()
        };
    }
    get isConnected() {
        const view = this.catalog?.snapshot.signaling;
        return (
            !this.stopped &&
            !!view?.valid &&
            view.backends.some(
                endpoint =>
                    endpoint.acceptNew &&
                    this.peers.get(endpoint.id)?.client &&
                    this.peers.get(endpoint.id)?.reconciled &&
                    same(this.peers.get(endpoint.id)?.endpoint, endpoint)
            )
        );
    }
    async start() {
        if (
            !this.config.RTC_ENDPOINTS_FILE ||
            !this.config.SIPBRIDGE_TLS_CERT_FILE ||
            !this.config.SIPBRIDGE_TLS_KEY_FILE ||
            !this.config.SIPBRIDGE_TLS_CA_FILE
        )
            throw new Error('Native SIP requires RTC_ENDPOINTS_FILE and all SIPBRIDGE_TLS files');
        this.catalog = new FileRtcEndpointCatalog(this.config.RTC_ENDPOINTS_FILE, this.config.RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT);
        this.stopped = false;
        this.timer = setInterval(() => {
            void this.refresh();
        }, 500);
        this.timer.unref();
        await this.refresh();
    }
    private async refresh() {
        if (this.stopped) return;
        const now = Date.now();
        for (const [id, marker] of this.events) if (marker.expires < now) this.events.delete(id);
        for (const [key, state] of this.contexts) {
            if (state.retiredAt !== undefined && now - state.retiredAt > 300000) this.contexts.delete(key);
            else if (state.expiresAt !== undefined && state.expiresAt <= now && !state.ended) this.drop(state, 'expired');
        }
        const view = this.catalog!.snapshot.signaling;
        if (view.valid)
            for (const endpoint of view.backends) {
                const old = this.peers.get(endpoint.id);
                // Changes in admission flags do not replace a physical session.
                if (old && (old.endpoint.url !== endpoint.url || old.endpoint.serverName !== endpoint.serverName)) {
                    if ([...this.contexts.values()].some(context => context.peer === old && !context.ended)) continue;
                    old.client?.close();
                    this.peers.delete(endpoint.id);
                }
                const peer = this.peers.get(endpoint.id) ?? {
                    endpoint,
                    connecting: false,
                    retryAt: 0,
                    delay: 250
                };
                peer.endpoint = endpoint;
                this.peers.set(endpoint.id, peer);
            }
        for (const peer of this.peers.values()) {
            const fresh =
                !!view.valid &&
                view.backends.some(
                    endpoint =>
                        endpoint.id === peer.endpoint.id && endpoint.url === peer.endpoint.url && endpoint.serverName === peer.endpoint.serverName
                );
            const retained = [...this.contexts.values()].some(context => context.peer === peer && !context.ended);
            if (!fresh && !retained) {
                peer.client?.close();
                this.peers.delete(peer.endpoint.id);
                continue;
            }
            if (!peer.client && !peer.connecting && peer.retryAt <= now) void this.connect(peer);
            const client = peer.client;
            if (client)
                void client
                    .status({
                        retainedReady: !!peer.reconciled,
                        bindingsReady: true,
                        admitCalls: fresh && !!peer.reconciled && this.applicationReady() && !this.isDraining(),
                        admitSubscriptions: false,
                        draining: this.isDraining()
                    })
                    .catch(() => client.close());
        }
    }
    private async connect(peer: Peer) {
        peer.connecting = true;
        try {
            const client = await SipbridgeControlClient.connect({
                url: peer.endpoint.url,
                serverName: peer.endpoint.serverName,
                process: this.process,
                connectionAttempt: ++this.attempt,
                certificateFile: this.config.SIPBRIDGE_TLS_CERT_FILE!,
                keyFile: this.config.SIPBRIDGE_TLS_KEY_FILE!,
                serverTrustFile: this.config.SIPBRIDGE_TLS_CA_FILE!,
                capabilities,
                onEnvelope: (client, frame) => {
                    // A per-message failure never closes the session: sipbridge ends every call of a lost session.
                    void this.receive(peer, client, frame).catch(() => undefined);
                }
            });
            if (this.stopped || this.peers.get(peer.endpoint.id) !== peer) {
                client.close();
                return;
            }
            if (client.negotiated.sipbridge?.instanceId !== peer.endpoint.id) {
                client.close();
                throw new Error('Native endpoint identity mismatch');
            }
            if (capabilities.some(value => !client.negotiated.capabilities.includes(value))) {
                client.close();
                throw new Error('Required native SIP capabilities unavailable');
            }
            peer.client = client;
            peer.delay = 250;
            peer.reconciled = false;
            void client.closed.then(() => {
                if (peer.client !== client) return;
                peer.client = undefined;
                peer.reconciled = false;
                peer.retryAt = Date.now() + peer.delay;
                peer.delay = Math.min(peer.delay * 2, 5000);
                // Memory sipbridge ends all calls of a lost session's term; reconnecting never restores them.
                for (const state of [...this.contexts.values()]) if (state.peer === peer) this.drop(state, 'session-lost');
                this.emit('disconnected');
            });
            const ack = client.negotiated;
            for (const state of this.contexts.values())
                if (
                    state.peer === peer &&
                    !state.ended &&
                    (!same(state.snapshot.context?.state?.authority, ack.stateAuthority) ||
                        state.snapshot.applicationLeaseTerm !== ack.applicationLease?.term)
                ) {
                    state.ended = true;
                    if (state.credentials) this.credentials.delete(state.credentials.id);
                    state.deferred?.reject(new NativeOperationError('Native authority changed', true));
                    state.dialog?.emit('ended', 'authority-changed');
                    if (state.snapshot.context) this.contexts.delete(contextKey(state.snapshot.context));
                }
            const retained = [...this.contexts.values()].filter(state => state.peer === peer && !state.ended);
            await Promise.all(
                Array.from({ length: Math.min(8, retained.length) }, async () => {
                    for (let state = retained.shift(); state; state = retained.shift()) await this.inspectRetained(peer, client, state);
                })
            );
            if (peer.client !== client || this.stopped) return;
            peer.reconciled = true;
            this.emit('connected');
            await this.refresh();
        } catch {
            peer.client?.close();
            peer.client = undefined;
            peer.reconciled = false;
            peer.retryAt = Date.now() + peer.delay;
            peer.delay = Math.min(peer.delay * 2, 5000);
        } finally {
            peer.connecting = false;
        }
    }
    private async inspectRetained(peer: Peer, client: SipbridgeControlClient, state: Context) {
        if (state.ended) return;
        const frame = await client.request({ $case: 'inspect', inspect: { context: state.snapshot.context } });
        if (frame.payload?.$case !== 'result') throw new Error('Invalid native inspection');
        const result = frame.payload.result;
        if (result.snapshot) {
            if (!result.snapshot.context || contextKey(result.snapshot.context) !== contextKey(state.snapshot.context!))
                throw new Error('Inspection context mismatch');
            this.remember(peer, client, result.snapshot);
            if (result.snapshot.ended) {
                this.retire(state, 'terminated');
                return;
            }
            if (result.certainty === OperationResult_Certainty.UNKNOWN) state.uncertain = true;
            if (!state.uncertain && result.snapshot.answered && state.deferred) {
                state.dialog ??= new NativeDialog(state, this);
                state.deferred.resolve(state.dialog);
            }
            return;
        }
        const proof = result.retirementProof;
        if (
            !result.error &&
            result.certainty === OperationResult_Certainty.COMPLETED &&
            proof?.context &&
            proof.authority &&
            contextKey(proof.context) === contextKey(state.snapshot.context!) &&
            same(proof.authority, client.negotiated.stateAuthority) &&
            [
                ContextRetirementProof_Reason.GROUP_ABSENT,
                ContextRetirementProof_Reason.OBSOLETE_INCARNATION,
                ContextRetirementProof_Reason.CONTEXT_ABSENT
            ].includes(proof.reason)
        ) {
            this.retire(state, 'terminated');
            return;
        }
        state.uncertain = true;
    }
    private retire(state: Context, reason: string) {
        if (state.ended) return;
        state.ended = true;
        state.retiredAt = Date.now();
        if (state.credentials) this.credentials.delete(state.credentials.id);
        state.deferred?.reject(new NativeOperationError('Native call ended'));
        state.dialog?.emit('ended', reason);
    }
    /** True when a snapshot belongs to an earlier authority or term than the current session. */
    private stale(client: SipbridgeControlClient, snapshot: ContextSnapshot): boolean {
        return (
            !same(snapshot.context?.state?.authority, client.negotiated.stateAuthority) ||
            snapshot.applicationLeaseTerm !== client.negotiated.applicationLease?.term
        );
    }
    /** Fences a context after an uncertain outcome; a first request that never became a dialog expires. */
    private fence(state: Context) {
        state.uncertain = true;
        if (state.first && !state.dialog && state.expiresAt === undefined) state.expiresAt = Date.now() + UNCERTAIN_FIRST_REQUEST_MS;
    }
    private expireUnanswered(state: Context) {
        if (state.first && !state.dialog && !state.ended && state.expiresAt === undefined) state.expiresAt = Date.now() + UNCERTAIN_FIRST_REQUEST_MS;
    }
    private drop(state: Context, reason: string) {
        this.retire(state, reason);
        if (state.snapshot.context) this.contexts.delete(contextKey(state.snapshot.context));
    }
    /**
     * `capacity`: 'enforce' throws when the table is full, 'transient' tracks an over-capacity request only
     * long enough to deny it, 'force' always records (terminal tombstones must never be lost).
     */
    private remember(
        peer: Peer,
        client: SipbridgeControlClient,
        snapshot: ContextSnapshot,
        capacity: 'enforce' | 'transient' | 'force' = 'enforce'
    ): Context {
        const ref = snapshot.context;
        if (
            !ref?.state ||
            !ref.id ||
            !ref.state.groupId ||
            !ref.state.incarnation ||
            !same(ref.state.authority, client.negotiated.stateAuthority) ||
            !processEqual(snapshot.application, this.process) ||
            snapshot.applicationLeaseTerm !== client.negotiated.applicationLease?.term
        )
            throw new Error('Native context ownership mismatch');
        const key = contextKey(ref);
        let state = this.contexts.get(key);
        if (state && state.peer !== peer) throw new Error('Native context peer mismatch');
        if (!state) {
            if (this.contexts.size >= MAX_CONTEXTS && capacity === 'enforce') throw new Error('Native context capacity');
            state = {
                peer,
                snapshot,
                sequence: snapshot.commandSequence,
                tail: Promise.resolve(),
                uncertain: false,
                ended: false
            };
            // At capacity a request is tracked only long enough to be denied.
            if (this.contexts.size < MAX_CONTEXTS || capacity === 'force') this.contexts.set(key, state);
        }
        if (snapshot.revision >= state.snapshot.revision) state.snapshot = snapshot;
        if (snapshot.commandSequence > state.sequence) state.sequence = snapshot.commandSequence;
        return state;
    }
    /** Records a receipt, evicting the oldest when full; capacity never refuses a message. */
    private receipt(key: string, fingerprint: string, fields: { dispatched?: boolean } = {}) {
        const prior = this.events.get(key);
        if (prior) return { marker: prior, created: false };
        while (this.events.size >= MAX_RECEIPTS) this.events.delete(this.events.keys().next().value!);
        const marker = { fingerprint, expires: Date.now() + RECEIPT_LIFETIME_MS, ...fields };
        this.events.set(key, marker);
        return { marker, created: true };
    }
    private async receive(peer: Peer, client: SipbridgeControlClient, frame: Envelope) {
        if (this.stopped || (peer.client && peer.client !== client)) return;
        const body = frame.payload;
        if (body?.$case === 'request') {
            const request = body.request;
            if (!request.snapshot?.context || !request.message || !request.requestId) throw new Error('Incomplete native request');
            const requestKey = contextKey(request.snapshot.context);
            if (this.stale(client, request.snapshot)) {
                // An earlier term's request; sipbridge refuses it natively. Never fail the current session.
                const old = this.contexts.get(requestKey);
                if (old) this.drop(old, 'authority-changed');
                return;
            }
            const fresh = !this.contexts.has(requestKey);
            const full = fresh && this.contexts.size >= MAX_CONTEXTS;
            const key = contextKey(request.snapshot.context!) + ':request:' + request.requestId;
            const fingerprint = createHash('sha256')
                .update(
                    JSON.stringify([
                        request.requestId,
                        request.message.wire,
                        request.flow,
                        request.snapshot.application,
                        request.snapshot.principalId,
                        request.snapshot.bindingId
                    ])
                )
                .digest('hex');
            const { marker } = this.receipt(key, fingerprint, { dispatched: false });
            if (marker.fingerprint !== fingerprint) throw new Error('Native request replay mismatch');
            // A request is a one-shot notification; the exact decision below is its only acceptance.
            if (marker.dispatched) return;
            marker.dispatched = true;
            const state = this.remember(peer, client, request.snapshot, full ? 'transient' : 'enforce');
            if (fresh) state.peerSource = sourceOf(request);
            const task = this.decide(state, request, fresh, full).then(admitted => (admitted ? this.present(state, request, fresh) : undefined));
            // A first request that leaves present() without a final response (e.g. not-sent failures) must still expire.
            if (fresh) void task.finally(() => this.expireUnanswered(state)).catch(() => undefined);
            this.pendingRequests.set(key, task);
            void task.catch(() => undefined).finally(() => this.pendingRequests.delete(key));
            return;
        }
        if (body?.$case === 'dialogEvent') {
            const event = body.dialogEvent;
            if (!event.snapshot?.context) throw new Error('Incomplete native dialog event');
            const eventKey = contextKey(event.snapshot.context);
            const terminal = [DialogEvent_Kind.ENDED, DialogEvent_Kind.FAILED, DialogEvent_Kind.CANCELLED].includes(event.kind);
            if (this.stale(client, event.snapshot)) {
                // Earlier-term lifecycle events are redelivered to the new session; accept and clean up.
                const old = this.contexts.get(eventKey);
                if (old) this.drop(old, 'authority-changed');
                await client.reply(frame.correlationId, { $case: 'result', result: emptyResult() });
                return;
            }
            // A current-term terminal event may precede the local record of its context (e.g. an outbound
            // open); it is kept as a tombstone, never refused for capacity.
            const state = this.remember(peer, client, event.snapshot, terminal ? 'force' : 'enforce');
            const key = contextKey(event.snapshot.context!) + ':' + frame.correlationId;
            const fingerprint = createHash('sha256')
                .update(JSON.stringify(DialogEvent.toJSON(event)))
                .digest('hex');
            const { marker: prior, created } = this.receipt(key, fingerprint);
            if (!created && prior.fingerprint !== fingerprint) throw new Error('Native event replay mismatch');
            await client.reply(frame.correlationId, { $case: 'result', result: emptyResult() });
            if (!created) return;
            if (event.kind === DialogEvent_Kind.PROVISIONAL) state.onProvisional?.(event.message?.status ?? 0);
            // Message presence distinguishes a peer re-INVITE ACK from the initial ACK (sip.reinvite-ack.v1).
            if (event.kind === DialogEvent_Kind.ACKNOWLEDGED && event.message && state.dialog)
                state.dialog.deliverAck(event.inviteCseq, Buffer.from(event.message.body).toString('utf8'));
            if (event.kind === DialogEvent_Kind.ANSWERED) {
                state.dialog ??= new NativeDialog(state, this);
                state.deferred?.resolve(state.dialog);
            }
            if ([DialogEvent_Kind.ENDED, DialogEvent_Kind.FAILED, DialogEvent_Kind.CANCELLED].includes(event.kind)) {
                state.ended = true;
                state.retiredAt = Date.now();
                state.deferred?.reject(new NativeOperationError(event.error || 'SIP call ended'));
                state.dialog?.emit('ended', event.kind === DialogEvent_Kind.ENDED ? 'bye' : 'terminated');
                if (state.credentials) this.credentials.delete(state.credentials.id);
            }
            return;
        }
        if (body?.$case === 'probeApplication') {
            const probe = body.probeApplication;
            const state = probe.context && this.contexts.get(contextKey(probe.context));
            await client.reply(frame.correlationId, {
                $case: 'applicationStatus',
                applicationStatus: {
                    context: probe.context,
                    application: probe.application,
                    directoryEpoch: this.process.epoch,
                    live:
                        !!state &&
                        state.peer === peer &&
                        !state.ended &&
                        processEqual(probe.application, this.process) &&
                        same(probe.context?.state?.authority, client.negotiated.stateAuthority),
                    checkedAtMs: BigInt(Date.now())
                }
            });
            return;
        }
        if (body?.$case === 'credentialLookup') {
            const lookup = body.credentialLookup;
            const credential = lookup.credential && this.credentials.get(lookup.credential.id);
            if (
                !credential ||
                credential.peer !== peer ||
                !lookup.context?.state ||
                credential.contextId !== lookup.context.id ||
                !same(lookup.context.state.authority, client.negotiated.stateAuthority) ||
                lookup.credential?.version !== '1' ||
                (credential.context && credential.context !== contextKey(lookup.context))
            ) {
                await client.reply(frame.correlationId, {
                    $case: 'credentialResult',
                    credentialResult: {
                        username: '',
                        password: '',
                        version: '',
                        error: 'Credential unavailable'
                    }
                });
                return;
            }
            credential.context = contextKey(lookup.context);
            await client.reply(frame.correlationId, {
                $case: 'credentialResult',
                credentialResult: {
                    username: credential.username,
                    password: credential.password,
                    version: '1',
                    error: ''
                }
            });
            return;
        }
        if (body?.$case === 'flowClosed') return; // A socket closure is not application/owner loss.
        throw new Error('Unsupported native message');
    }
    /**
     * Policy hook for one pending native request. Returns the SIP status to deny with, or undefined to admit
     * (the response is then sent with ordinary commands). Source-based admission policy plugs in here.
     */
    private admission(request: RequestPresented, fresh: boolean, full: boolean): number | undefined {
        const message = request.message!;
        if (fresh && (full || !this.isConnected || !this.applicationReady() || this.isDraining() || !this.acceptingIngress(message))) return 503;
        if (fresh && this.banPolicy?.(sourceOf(request))) return 403;
        // REGISTER and SUBSCRIBE need a final decision; this application serves neither.
        if (message.method === 'REGISTER' || message.method === 'SUBSCRIBE') return 405;
        // A tagged or answered request for a context RTC no longer tracks belongs to a forgotten dialog, never a new call.
        if (fresh && (message.addresses?.to?.values[0]?.params?.tag || request.snapshot?.answered)) return 481;
        // A first request is admitted only if present() answers it; anything else would hold a context forever.
        if (fresh && !ANSWERED_FIRST_METHODS.includes(message.method)) return DIALOG_ONLY_METHODS.includes(message.method) ? 481 : 405;
        // sipbridge proposes flow adoption only when the request's flow differs from the context's; no socket migration.
        if (request.flowAdoption) return 403;
        if (fresh && this.routePolicy) return this.routePolicy(message, sourceOf(request));
        return undefined;
    }
    /** Submits the single native decision for a request; resolves true when the request was admitted for handling. */
    private async decide(state: Context, request: RequestPresented, fresh: boolean, full: boolean): Promise<boolean> {
        const status = this.admission(request, fresh, full) ?? 0;
        const admitted = status === 0;
        if (fresh) state.first = true;
        try {
            await this.enqueue(state, async () => {
                if (state.uncertain || state.ended) throw new NativeOperationError('Native call is ended or uncertain', state.uncertain);
                const client = state.peer.client;
                if (!client) throw new NativeOperationError('Native session unavailable', false, true);
                const decision: RequestDecision = {
                    context: state.snapshot.context,
                    requestId: request.requestId,
                    sequence: state.sequence + 1n,
                    admission: {
                        directoryEpoch: this.process.epoch,
                        expiresAtMs: BigInt(Date.now() + 40000),
                        expectedDelivery: state.snapshot.delivery
                    },
                    basis: OwnerIngest_Admission.EXISTING_FLOW,
                    principalId: admitted ? state.snapshot.principalId : '',
                    bindingId: admitted ? state.snapshot.bindingId : '',
                    status,
                    headers: status === 405 ? nativeHeaders({ Allow: ALLOW }) : [],
                    body: Buffer.alloc(0)
                };
                try {
                    const frame = await client.request({ $case: 'requestDecision', requestDecision: decision });
                    if (frame.payload?.$case !== 'result') throw new NativeOperationError('Unexpected native result', true);
                    const outcome = frame.payload.result;
                    if (outcome.snapshot) this.remember(state.peer, client, outcome.snapshot, fresh ? 'transient' : 'enforce');
                    if (outcome.certainty !== OperationResult_Certainty.ACCEPTED || outcome.error)
                        throw new NativeOperationError(
                            outcome.error || 'Native decision refused',
                            outcome.certainty === OperationResult_Certainty.UNKNOWN
                        );
                } catch (error) {
                    if (error instanceof SipbridgeControlNotSentError) throw new NativeOperationError(error.message, false, true);
                    if (!(error instanceof NativeOperationError) || error.uncertain) this.fence(state);
                    throw error instanceof NativeOperationError ? error : new NativeOperationError('Native decision outcome unknown', true);
                }
            });
            // A denied first request leaves no context behind.
            if (!admitted && fresh) this.drop(state, 'rejected');
            return admitted;
        } catch (error) {
            // The unanswered request receives a bounded native refusal; nothing was admitted. An uncertain
            // outcome keeps the (fenced) context until its bounded expiry; a definite refusal releases it.
            if (fresh && !(error instanceof NativeOperationError && error.uncertain)) this.drop(state, 'rejected');
            return false;
        }
    }
    private async present(state: Context, request: RequestPresented, fresh: boolean) {
        const message = request.message!;
        const headers = Object.fromEntries(message.headers.map(header => [header.name.toLowerCase(), header.value]));
        const incoming: IncomingSipRequest = {
            method: message.method,
            uri: message.uri,
            callId: request.snapshot!.callId,
            body: Buffer.from(message.body).toString('utf8'),
            cseq: Number.parseInt(headers['cseq'] ?? '', 10) || 0,
            headers,
            source: sourceOf(request),
            get: name => headers[name.toLowerCase()]
        };
        const response: SipResponse = {
            finalResponseSent: false,
            respond: async (status, options = {}) => {
                if (response.finalResponseSent || state.ended) throw new Error('Native request already ended');
                await this.command(state, {
                    $case: 'respond',
                    respond: {
                        requestId: request.requestId,
                        status,
                        headers: nativeHeaders(options.headers),
                        body: Buffer.from(options.body ?? ''),
                        principalId: state.snapshot.principalId,
                        bindingId: state.snapshot.bindingId,
                        authority: { directoryEpoch: this.process.epoch, completionScope: 'response' }
                    }
                });
                if (status >= 200) response.finalResponseSent = true;
                // A first request answered without creating a dialog (denial, OPTIONS, ...) holds no call.
                if (fresh && status >= 200 && !state.dialog && (status >= 300 || message.method !== 'INVITE')) this.drop(state, 'rejected');
            },
            answer: async (sdp, headers) => {
                await response.respond(200, { body: sdp, headers });
                if (state.ended) throw new NativeOperationError('Call ended while answering');
                state.dialog ??= new NativeDialog(state, this);
                state.first = false;
                state.expiresAt = undefined;
                return state.dialog;
            }
        };
        if (state.dialog && DIALOG_REQUEST_METHODS.includes(message.method)) {
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    state.dialog.applicationAttached,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Application dialog attachment deadline')), 2000);
                    })
                ]);
                // Without a handler an in-dialog UPDATE/REFER would hang; INVITE keeps its attachment-bounded path.
                if (message.method !== 'INVITE' && state.dialog.listenerCount('request') === 0)
                    await response.respond(405, { headers: { Allow: ALLOW } });
                else state.dialog.emit('request', incoming, response);
            } finally {
                clearTimeout(timer);
            }
        } else if (message.method === 'INVITE') {
            if (this.onInvite) await this.onInvite(incoming, response);
            else await response.respond(503);
        } else if (message.method === 'OPTIONS') await response.respond(200, { headers: { Allow: ALLOW } });
        else if (!['ACK', 'CANCEL', 'BYE'].includes(message.method)) await response.respond(405, { headers: { Allow: ALLOW } });
    }
    private enqueue<T>(state: Context, work: () => Promise<T>): Promise<T> {
        if ((state.pendingCommands ?? 0) >= 8) throw new NativeOperationError('Native context command capacity');
        state.pendingCommands = (state.pendingCommands ?? 0) + 1;
        const result = state.tail.then(work).finally(() => {
            state.pendingCommands!--;
        });
        state.tail = result.catch(() => undefined);
        return result;
    }
    async command(state: Context, action: NonNullable<Command['action']>): Promise<ContextSnapshot> {
        const work = async () => {
            if (state.uncertain || state.ended) throw new NativeOperationError('Native call is ended or uncertain', state.uncertain);
            const client = state.peer.client;
            if (!client) throw new NativeOperationError('Native session unavailable', false, true);
            const sequence = state.sequence + 1n;
            try {
                const frame = await client.request({
                    $case: 'command',
                    command: {
                        context: state.snapshot.context,
                        sequence,
                        action,
                        admission: {
                            directoryEpoch: this.process.epoch,
                            expiresAtMs: BigInt(Date.now() + 40000),
                            expectedDelivery: state.snapshot.delivery,
                            selectedFlow: state.snapshot.delivery?.flow
                        }
                    }
                });
                if (frame.payload?.$case !== 'result') throw new NativeOperationError('Unexpected native result', true);
                const result = frame.payload.result;
                if (result.snapshot) this.remember(state.peer, client, result.snapshot);
                if (
                    ![OperationResult_Certainty.NOT_ACCEPTED, OperationResult_Certainty.ACCEPTED, OperationResult_Certainty.COMPLETED].includes(
                        result.certainty
                    )
                )
                    throw new NativeOperationError('Native outcome unknown', true);
                if (action.$case === 'dialogRequest' && result.certainty === OperationResult_Certainty.COMPLETED) {
                    const method = action.dialogRequest.method.toUpperCase();
                    const status = result.sipStatus ?? 0;
                    if (method !== 'ACK' && method !== 'BYE') {
                        // 408/481 (or no response at all) to a re-INVITE, or 481 to an in-dialog request, means the dialog is gone.
                        // A 481 to NOTIFY/SUBSCRIBE ends only that subscription usage (RFC 6665), not the INVITE dialog.
                        const dialogGone =
                            method === 'INVITE'
                                ? status === 408 || status === 481 || status === 0
                                : status === 481 && method !== 'NOTIFY' && method !== 'SUBSCRIBE';
                        if (result.error) throw new NativeOperationError(result.error, false, false, status, dialogGone);
                        // A peer's non-2xx final is a definite failure: it neither fences the context nor is uncertain. The
                        // snapshot above is already remembered.
                        if (status < 200 || status >= 300)
                            throw new NativeOperationError(`SIP non-success response: ${status}`, false, false, status, dialogGone);
                    }
                }
                // NOT_ACCEPTED is a local refusal (even with a 481 status): never dialog-gone.
                if (result.error || result.certainty === OperationResult_Certainty.NOT_ACCEPTED)
                    throw new NativeOperationError(result.error || 'Native command refused', false, false, result.sipStatus ?? 0);
                if (!result.snapshot) throw new NativeOperationError('Native result omitted context', true);
                return result.snapshot;
            } catch (error) {
                if (error instanceof SipbridgeControlNotSentError) throw new NativeOperationError(error.message, false, true);
                if (!(error instanceof NativeOperationError) || error.uncertain) this.fence(state);
                throw error instanceof NativeOperationError ? error : new NativeOperationError('Native command outcome unknown', true);
            }
        };
        return this.enqueue(state, work);
    }
    openDialog(params: OutboundSipCallParams): OutboundAttempt {
        let state: Context | undefined;
        let cancelled = false;
        const completed = (async () => {
            if (!this.isConnected || !this.applicationReady() || this.isDraining())
                throw new NativeOperationError('Native SIP admission unavailable', false, true);
            const peer = [...this.peers.values()].find(peer => peer.client && peer.endpoint.acceptNew)!;
            const client = peer.client!;
            // Record the context only after the INVITE is accepted, so capacity must be known first.
            if (this.contexts.size >= MAX_CONTEXTS) throw new NativeOperationError('Native context capacity', false, true);
            const bootstrapId = randomUUID();
            const credentialId = params.auth ? randomUUID() : undefined;
            if (credentialId) this.credentials.set(credentialId, { peer, contextId: bootstrapId, ...params.auth! });
            let dispatched = false;
            try {
                const transport = /^sips:/i.test(params.requestUri)
                    ? 'tls'
                    : (/;transport=(tcp|udp|tls)(?:;|\?|$)/i.exec(params.requestUri)?.[1].toLowerCase() ?? 'udp');
                const headers = { ...params.headers };
                if (params.callingNumber && !Object.keys(headers).some(name => name.toLowerCase() === 'from')) {
                    if (/[\r\n<>"\\]/.test(params.callingName ?? '') || !/^[+a-zA-Z0-9_.-]+$/.test(params.callingNumber))
                        throw new Error('Invalid caller identity');
                    headers.From = `${params.callingName ? '"' + params.callingName + '" ' : ''}<sip:${params.callingNumber}@${this.config.SIP_ALLOWED_DOMAINS?.[0] ?? 'rtc.invalid'}>`;
                }
                const headerList = nativeHeaders(headers);
                dispatched = true;
                const response = await client.request({
                    $case: 'command',
                    command: {
                        context: { owner: client.negotiated.sipbridge, id: bootstrapId },
                        sequence: 1n,
                        admission: {
                            directoryEpoch: this.process.epoch,
                            expiresAtMs: BigInt(Date.now() + 40000)
                        },
                        action: {
                            $case: 'openUac',
                            openUac: {
                                uri: params.requestUri,
                                body: Buffer.from(params.sdp),
                                headers: headerList,
                                bindingId: '',
                                principalId: '',
                                method: 'INVITE',
                                transport,
                                network: {
                                    proxy: params.proxy ?? '',
                                    transport,
                                    credential: credentialId ? { id: credentialId, version: '1' } : undefined
                                }
                            }
                        }
                    }
                });
                if (response.payload?.$case !== 'result') throw new NativeOperationError('Outbound native result unavailable', true);
                const result = response.payload.result;
                if (result.certainty === OperationResult_Certainty.NOT_ACCEPTED)
                    throw new NativeOperationError(result.error || 'Outbound native command refused');
                if (!result.snapshot) throw new NativeOperationError('Outbound native context unavailable', true);
                state = this.remember(peer, client, result.snapshot!, 'force');
                state.onProvisional = status => attempt.onProvisional?.(status);
                if (credentialId) state.credentials = { id: credentialId };
                if (![OperationResult_Certainty.ACCEPTED, OperationResult_Certainty.COMPLETED].includes(result.certainty))
                    throw new NativeOperationError('Outbound native outcome unknown', true);
                if (result.error) throw new NativeOperationError(result.error);
                if (cancelled)
                    try {
                        await this.command(state, { $case: 'cancel', cancel: {} });
                    } catch (error) {
                        // The INVITE is already on the wire; a failed CANCEL never makes the outcome safely retryable.
                        this.fence(state);
                        throw new NativeOperationError(error instanceof Error ? error.message : 'Outbound cancel failed', true);
                    }
                if (state.ended) throw new NativeOperationError('Outbound call ended');
                if (state.snapshot.answered) {
                    state.dialog ??= new NativeDialog(state, this);
                    return state.dialog;
                }
                if (state.ended) throw new NativeOperationError('Outbound call ended');
                state.deferred ??= Promise.withResolvers<NativeDialog>();
                const timer = setTimeout(() => state!.deferred?.reject(new NativeOperationError('Outbound setup deadline', true)), 40000);
                try {
                    return await state.deferred.promise;
                } finally {
                    clearTimeout(timer);
                }
            } catch (error) {
                if (credentialId) this.credentials.delete(credentialId);
                if (error instanceof SipbridgeControlNotSentError) throw new NativeOperationError(error.message, false, true);
                if (!(error instanceof NativeOperationError))
                    throw new NativeOperationError(dispatched ? 'Native operation outcome unknown' : 'Invalid outbound SIP parameters', dispatched);
                throw error;
            }
        })();
        void completed.catch(() => undefined);
        const attempt: OutboundAttempt = {
            completed,
            cancel: async () => {
                cancelled = true;
                if (state && !state.ended) await this.command(state, { $case: 'cancel', cancel: {} });
            }
        };
        return attempt;
    }
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.catalog?.destroy();
        for (const peer of this.peers.values()) peer.client?.close();
        for (const context of this.contexts.values()) context.deferred?.reject(new NativeOperationError('Gateway stopping', true));
        this.credentials.clear();
        this.peers.clear();
        this.contexts.clear();
        this.events.clear();
    }
}
function nativeHeaders(headers?: Record<string, string>) {
    return Object.entries(headers ?? {}).map(([name, value]) => {
        if (!/^[A-Za-z0-9-]{1,127}$/.test(name) || /[\r\n\0]/.test(value) || value.length > 8192) throw new Error('Invalid SIP header');
        return { name, value };
    });
}
