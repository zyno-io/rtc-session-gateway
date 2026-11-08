import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { FileRtcEndpointCatalog, type SignalingBackend } from './endpoint-catalog';
import type { GatewayConfig } from './config';
import { SipbridgeControlClient } from './sipbridge/client';
import {
    SIPBRIDGE_CAPABILITY,
    SIPBRIDGE_STATE_CAPABILITY,
    SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY,
    SIPBRIDGE_COMMAND_ADMISSION_CAPABILITY,
    SIPBRIDGE_COMMAND_BUDGET_CAPABILITY,
    SIPBRIDGE_DIRECTORY_RECONCILE_CAPABILITY,
    SIPBRIDGE_COMPLETION_RELAY_CAPABILITY
} from './sipbridge/codec';
import {
    Command,
    ContextSnapshot,
    ContextRetirementProof_Reason,
    DialogEvent,
    DialogEvent_Kind,
    OperationResult_Certainty,
    OwnerIngest_Admission,
    RouteResult_Outcome,
    type ContextRef,
    type Envelope,
    type FlowRef,
    type ProcessRef,
    RequestPresented,
    type SipMessage
} from './sipbridge/generated/sipbridge-control';
import type { OutboundSipCallParams } from './sip-gateway';

const capabilities = [
    SIPBRIDGE_CAPABILITY,
    SIPBRIDGE_STATE_CAPABILITY,
    SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY,
    SIPBRIDGE_COMMAND_ADMISSION_CAPABILITY,
    SIPBRIDGE_COMMAND_BUDGET_CAPABILITY,
    SIPBRIDGE_DIRECTORY_RECONCILE_CAPABILITY,
    SIPBRIDGE_COMPLETION_RELAY_CAPABILITY
];
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
        readonly unavailable = false
    ) {
        super(message);
    }
}
export interface IncomingSipRequest {
    method: string;
    uri: string;
    callId: string;
    body: string;
    headers: Record<string, string>;
    get(name: string): string | undefined;
}
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
}
export class NativeDialog extends EventEmitter {
    constructor(
        readonly state: Context,
        private owner: SipbridgeSignaling
    ) {
        super();
    }
    private attached = Promise.withResolvers<void>();
    activate() {
        this.attached.resolve();
    }
    get applicationAttached() {
        return this.attached.promise;
    }
    get isEnded() {
        return this.state.ended;
    }
    get sipCallId() {
        return this.state.snapshot.callId;
    }
    get localSdp() {
        return Buffer.from(this.state.snapshot.localSdp).toString('utf8');
    }
    get remoteSdp() {
        return Buffer.from(this.state.snapshot.remoteSdp).toString('utf8');
    }
    async reinvite(sdp: string, headers?: Record<string, string>) {
        const snapshot = await this.owner.command(this.state, {
            $case: 'dialogRequest',
            dialogRequest: { method: 'INVITE', body: Buffer.from(sdp), headers: nativeHeaders(headers) }
        });
        return Buffer.from(snapshot.remoteSdp).toString('utf8');
    }
    async bye(headers?: Record<string, string>) {
        await this.owner.command(this.state, {
            $case: 'dialogRequest',
            dialogRequest: { method: 'BYE', body: Buffer.alloc(0), headers: nativeHeaders(headers) }
        });
    }
}
export interface OutboundAttempt {
    cancel(): Promise<void>;
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
        for (const [key, state] of this.contexts) if (state.retiredAt !== undefined && now - state.retiredAt > 300000) this.contexts.delete(key);
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
                    void this.receive(peer, client, frame).catch(() => client.close());
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
    private remember(peer: Peer, client: SipbridgeControlClient, snapshot: ContextSnapshot): Context {
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
            if (this.contexts.size >= 1024) throw new Error('Native context capacity');
            state = {
                peer,
                snapshot,
                sequence: snapshot.commandSequence,
                tail: Promise.resolve(),
                uncertain: false,
                ended: false
            };
            this.contexts.set(key, state);
        }
        if (snapshot.revision >= state.snapshot.revision) state.snapshot = snapshot;
        if (snapshot.commandSequence > state.sequence) state.sequence = snapshot.commandSequence;
        return state;
    }
    private async receive(peer: Peer, client: SipbridgeControlClient, frame: Envelope) {
        if (this.stopped || (peer.client && peer.client !== client)) return;
        const body = frame.payload;
        if (body?.$case === 'ingress') {
            const { context, flow, message } = body.ingress;
            if (!message || !flow?.ingress) throw new Error('Incomplete native ingress');
            let state: Context | undefined;
            if (context) state = this.contexts.get(contextKey(context));
            const fresh =
                !state &&
                message.status === 0 &&
                !message.addresses.to?.values.some(address => address.params.tag) &&
                !['ACK', 'CANCEL', 'BYE'].includes(message.method);
            if (
                (!state && !fresh) ||
                (fresh && (!this.isConnected || !this.applicationReady() || this.isDraining() || !this.acceptingIngress(message)))
            ) {
                await client.reply(frame.correlationId, {
                    $case: 'routeResult',
                    routeResult: { outcome: RouteResult_Outcome.REJECTED, sipStatus: fresh ? 503 : 481 }
                });
                return;
            }
            // No header/Call-ID matching, socket migration or arbitrary controller redirects.
            if (state?.snapshot.delivery?.flow && !same(state.snapshot.delivery.flow, flow)) {
                await client.reply(frame.correlationId, {
                    $case: 'routeResult',
                    routeResult: { outcome: RouteResult_Outcome.REJECTED, sipStatus: 403 }
                });
                return;
            }
            const result = await client.request({
                $case: 'ingest',
                ingest: {
                    context,
                    application: this.process,
                    flow,
                    wire: message.wire,
                    principalId: state?.snapshot.principalId ?? '',
                    bindingId: state?.snapshot.bindingId ?? '',
                    authenticated: false,
                    admission: OwnerIngest_Admission.EXISTING_FLOW
                }
            });
            const accepted = result.payload?.$case === 'result' && !result.payload.result.error;
            await client.reply(frame.correlationId, {
                $case: 'routeResult',
                routeResult: {
                    outcome: accepted ? RouteResult_Outcome.ACCEPTED : RouteResult_Outcome.UNAVAILABLE,
                    sipStatus: accepted ? 0 : 503
                }
            });
            return;
        }
        if (body?.$case === 'request') {
            const request = body.request;
            if (!request.snapshot || !request.message || !request.requestId) throw new Error('Incomplete native request');
            const state = this.remember(peer, client, request.snapshot);
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
            const marker = this.events.get(key) ?? {
                fingerprint,
                expires: Date.now() + 300000,
                dispatched: false
            };
            if (marker.fingerprint !== fingerprint) throw new Error('Native request replay mismatch');
            if (!this.events.has(key) && this.events.size >= 8192) throw new Error('Native request receipt capacity');
            this.events.set(key, marker);
            await client.reply(frame.correlationId, { $case: 'result', result: emptyResult() });
            if (marker.dispatched) return;
            marker.dispatched = true;
            const task = this.present(state, request);
            this.pendingRequests.set(key, task);
            void task.catch(() => undefined).finally(() => this.pendingRequests.delete(key));
            return;
        }
        if (body?.$case === 'dialogEvent') {
            const event = body.dialogEvent;
            if (!event.snapshot) throw new Error('Incomplete native dialog event');
            const state = this.remember(peer, client, event.snapshot);
            const key = contextKey(event.snapshot.context!) + ':' + frame.correlationId;
            const fingerprint = createHash('sha256')
                .update(JSON.stringify(DialogEvent.toJSON(event)))
                .digest('hex');
            const prior = this.events.get(key);
            if (prior && prior.fingerprint !== fingerprint) throw new Error('Native event replay mismatch');
            if (!prior) {
                if (this.events.size >= 8192) throw new Error('Native event capacity');
                this.events.set(key, { fingerprint, expires: Date.now() + 300000 });
            }
            await client.reply(frame.correlationId, { $case: 'result', result: emptyResult() });
            if (prior) return;
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
        if (body?.$case === 'flowAdoption') {
            const adoption = body.flowAdoption;
            const state = adoption.context && this.contexts.get(contextKey(adoption.context));
            if (
                !state ||
                state.peer !== peer ||
                !processEqual(adoption.application, this.process) ||
                !adoption.flow ||
                adoption.principalId !== state.snapshot.principalId ||
                adoption.bindingId !== state.snapshot.bindingId ||
                adoption.nativeRevision < (state.snapshot.delivery?.nativeRevision ?? 0n)
            )
                throw new Error('Invalid context delivery adoption');
            if (state.snapshot.delivery?.flow && !same(adoption.flow, state.snapshot.delivery.flow))
                throw new Error('Physical flow replacement requires separate authentication policy');
            const receipt = {
                flow: adoption.flow,
                nativeRevision: adoption.nativeRevision,
                directoryEpoch: this.process.epoch,
                registrationTicket: ''
            };
            await client.reply(frame.correlationId, {
                $case: 'flowAdoptionResult',
                flowAdoptionResult: { receipt, error: '' }
            });
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
    private async present(state: Context, request: RequestPresented) {
        const message = request.message!;
        const headers = Object.fromEntries(message.headers.map(header => [header.name.toLowerCase(), header.value]));
        const incoming: IncomingSipRequest = {
            method: message.method,
            uri: message.uri,
            callId: request.snapshot!.callId,
            body: Buffer.from(message.body).toString('utf8'),
            headers,
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
            },
            answer: async (sdp, headers) => {
                await response.respond(200, { body: sdp, headers });
                if (state.ended) throw new NativeOperationError('Call ended while answering');
                state.dialog ??= new NativeDialog(state, this);
                return state.dialog;
            }
        };
        if (state.dialog && message.method === 'INVITE') {
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    state.dialog.applicationAttached,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error('Application dialog attachment deadline')), 2000);
                    })
                ]);
                state.dialog.emit('request', incoming, response);
            } finally {
                clearTimeout(timer);
            }
        } else if (message.method === 'INVITE') {
            if (this.onInvite) await this.onInvite(incoming, response);
            else await response.respond(503);
        } else if (message.method === 'OPTIONS') await response.respond(200, { headers: { Allow: 'INVITE, ACK, CANCEL, BYE, OPTIONS' } });
        else if (!['ACK', 'CANCEL', 'BYE'].includes(message.method))
            await response.respond(405, { headers: { Allow: 'INVITE, ACK, CANCEL, BYE, OPTIONS' } });
    }
    async command(state: Context, action: NonNullable<Command['action']>): Promise<ContextSnapshot> {
        if ((state.pendingCommands ?? 0) >= 8) throw new NativeOperationError('Native context command capacity');
        state.pendingCommands = (state.pendingCommands ?? 0) + 1;
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
                if (result.error || result.certainty === OperationResult_Certainty.NOT_ACCEPTED)
                    throw new NativeOperationError(result.error || 'Native command refused');
                if (!result.snapshot) throw new NativeOperationError('Native result omitted context', true);
                return result.snapshot;
            } catch (error) {
                if (!(error instanceof NativeOperationError) || error.uncertain) state.uncertain = true;
                throw error instanceof NativeOperationError ? error : new NativeOperationError('Native command outcome unknown', true);
            }
        };
        const result = state.tail.then(work).finally(() => {
            state.pendingCommands!--;
        });
        state.tail = result.catch(() => undefined);
        return result;
    }
    openDialog(params: OutboundSipCallParams): OutboundAttempt {
        let state: Context | undefined;
        let cancelled = false;
        const completed = (async () => {
            if (!this.isConnected || !this.applicationReady() || this.isDraining())
                throw new NativeOperationError('Native SIP admission unavailable', false, true);
            const peer = [...this.peers.values()].find(peer => peer.client && peer.endpoint.acceptNew)!;
            const client = peer.client!;
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
                                    username: '',
                                    password: '',
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
                state = this.remember(peer, client, result.snapshot!);
                if (credentialId) state.credentials = { id: credentialId };
                if (![OperationResult_Certainty.ACCEPTED, OperationResult_Certainty.COMPLETED].includes(result.certainty))
                    throw new NativeOperationError('Outbound native outcome unknown', true);
                if (result.error) throw new NativeOperationError(result.error);
                if (cancelled) await this.command(state, { $case: 'cancel', cancel: {} });
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
                if (!(error instanceof NativeOperationError))
                    throw new NativeOperationError(dispatched ? 'Native operation outcome unknown' : 'Invalid outbound SIP parameters', dispatched);
                throw error;
            }
        })();
        void completed.catch(() => undefined);
        return {
            completed,
            cancel: async () => {
                cancelled = true;
                if (state && !state.ended) await this.command(state, { $case: 'cancel', cancel: {} });
            }
        };
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
