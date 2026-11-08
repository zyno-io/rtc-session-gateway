import type { RawData } from 'ws';

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

import type { Command, ContextRef, Envelope, ProcessRef, SessionHelloAck, SessionStatus } from './generated/sipbridge-control';

import { sipbridgeOperationBudget } from './codec';
import {
    decodeSipbridgeFrame,
    encodeSipbridgeFrame,
    isSipbridgeProcess,
    isSipbridgeReference,
    isSipbridgeStateAuthority,
    SIPBRIDGE_COMMAND_BUDGET_CAPABILITY,
    SIPBRIDGE_COMPLETION_RELAY_CAPABILITY,
    SIPBRIDGE_DIRECTORY_RECONCILE_CAPABILITY,
    SIPBRIDGE_MAX_ENVELOPE_BYTES,
    SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY,
    SIPBRIDGE_LOCAL_CHALLENGE_CAPABILITY,
    hasSipbridgeStateCapability,
    SIPBRIDGE_STAGING_CAPABILITY,
    SIPBRIDGE_SUBPROTOCOL
} from './codec';

export interface SipbridgeControlOptions {
    url: string;
    process: ProcessRef;
    connectionAttempt: bigint;
    certificateFile: string;
    keyFile: string;
    serverTrustFile: string;
    serverName?: string;
    maxEnvelopeBytes?: number;
    helloTimeoutMs?: number;
    capabilities?: string[];
    onEnvelope?: (client: SipbridgeControlClient, envelope: Envelope) => void;
    onClose?: (diagnostic: Readonly<SipbridgeControlCloseDiagnostic>) => void;
}

export type SipbridgeControlCloseReason =
    | 'peer-closed'
    | 'socket-error'
    | 'hello-failed'
    | 'protocol-error'
    | 'unexpected-result'
    | 'stale-session'
    | 'heartbeat-mismatch'
    | 'heartbeat-timeout'
    | 'write-error'
    | 'write-capacity'
    | 'write-timeout'
    | 'requested';

export interface SipbridgeControlCloseDiagnostic {
    reason: SipbridgeControlCloseReason;
    closeCode?: number;
    peerInstanceId?: string;
    sessionId?: string;
}

export function sipbridgeCallIdHash(value: string | undefined): string | undefined {
    const callId = value?.trim();
    return callId && callId.length <= 512 && /^[!-~]+$/.test(callId) ? createHash('sha256').update(callId).digest('hex') : undefined;
}

function protocolCloseReason(error: unknown): SipbridgeControlCloseReason {
    if (error instanceof Error) {
        if (error.message === 'unexpected sipbridge operation result') return 'unexpected-result';
        if (error.message === 'stale sipbridge session') return 'stale-session';
        if (error.message === 'unexpected heartbeat reply') return 'heartbeat-mismatch';
    }
    return 'protocol-error';
}

export interface SipbridgeControlDeadlineDiagnostic {
    operation: NonNullable<Envelope['payload']>['$case'];
    correlationId: string;
    budgetMs: number;
    elapsedMs: number;
    peerInstanceId?: string;
    sessionId?: string;
    contextId?: string;
    commandType?: NonNullable<Command['action']>['$case'];
    callIdHash?: string;
}

/** Local diagnostics only; the request's outcome remains unknown. */
export class SipbridgeControlDeadlineError extends Error {
    readonly diagnostic: Readonly<SipbridgeControlDeadlineDiagnostic>;

    constructor(diagnostic: SipbridgeControlDeadlineDiagnostic) {
        super('control operation deadline; outcome unknown');
        const callIdHash = /^[a-f0-9]{64}$/.test(diagnostic.callIdHash ?? '') ? diagnostic.callIdHash : undefined;
        this.diagnostic = Object.freeze({
            operation: diagnostic.operation,
            correlationId: diagnostic.correlationId,
            budgetMs: diagnostic.budgetMs,
            elapsedMs: diagnostic.elapsedMs,
            peerInstanceId: diagnosticReference(diagnostic.peerInstanceId),
            sessionId: diagnosticReference(diagnostic.sessionId),
            contextId: diagnosticReference(diagnostic.contextId),
            commandType: diagnostic.commandType,
            ...(callIdHash ? { callIdHash } : {})
        });
    }
}

function controlContext(payload: NonNullable<Envelope['payload']>): ContextRef | undefined {
    switch (payload.$case) {
        case 'command':
            return payload.command.context;
        case 'ingest':
            return payload.ingest.context;
        case 'inspect':
            return payload.inspect.context;
        case 'flowAdoption':
            return payload.flowAdoption.context;
        case 'reconcileContext':
            return payload.reconcileContext.context;
        case 'reconcileAuthority':
            return payload.reconcileAuthority.snapshot?.context;
        case 'authorityReceipt':
            return payload.authorityReceipt.context;
        case 'retireAuthority':
            return payload.retireAuthority.context;
        default:
            return undefined;
    }
}

const diagnosticReference = (value: string | undefined): string | undefined => (value && isSipbridgeReference(value) ? value : undefined);

/** One authenticated session. The owner chooses reconnect policy; mutations are never replayed. */
export class SipbridgeControlClient {
    readonly closed: Promise<void>;
    private readonly resolveClosed: () => void;
    private session = '';
    private bound: number;
    private ack: SessionHelloAck | undefined;
    private heartbeat: NodeJS.Timeout | undefined;
    private pendingHeartbeat: { id: string; sent: number } | undefined;
    private pendingWrites = 0;
    private stopped = false;
    private stopReason: SipbridgeControlCloseReason | undefined;
    private readonly pending = new Map<string, { resolve: (value: Envelope) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private readonly expired = new Map<string, number>();
    private readonly helloId = randomUUID();

    private constructor(
        private readonly socket: WebSocket,
        private readonly options: SipbridgeControlOptions
    ) {
        this.bound = options.maxEnvelopeBytes ?? SIPBRIDGE_MAX_ENVELOPE_BYTES;
        const closed = Promise.withResolvers<void>();
        this.closed = closed.promise;
        this.resolveClosed = closed.resolve;
        socket.once('close', code => {
            this.stop('peer-closed');
            try {
                this.options.onClose?.(
                    Object.freeze({
                        reason: this.stopReason!,
                        closeCode: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : undefined,
                        peerInstanceId: diagnosticReference(this.ack?.sipbridge?.instanceId),
                        sessionId: diagnosticReference(this.session)
                    })
                );
            } catch {
                // An observer cannot change connection cleanup or completion.
            }
            this.resolveClosed();
        });
        socket.on('error', () => this.stop('socket-error'));
    }

    static async connect(options: SipbridgeControlOptions): Promise<SipbridgeControlClient> {
        const url = new URL(options.url);
        if (url.protocol !== 'wss:' || url.pathname !== '/v1/control' || url.search || url.hash || url.username || url.password) {
            throw new Error('sipbridge requires a configured private WSS control endpoint');
        }
        const bound = options.maxEnvelopeBytes ?? SIPBRIDGE_MAX_ENVELOPE_BYTES;
        const timeout = options.helloTimeoutMs ?? 5000;
        if (
            (hasSipbridgeStateCapability(options.capabilities) &&
                (!options.capabilities?.includes(SIPBRIDGE_DIRECTORY_RECONCILE_CAPABILITY) ||
                    !options.capabilities?.includes(SIPBRIDGE_COMPLETION_RELAY_CAPABILITY))) ||
            !isSipbridgeProcess(options.process) ||
            options.connectionAttempt <= 0n ||
            options.connectionAttempt > 0xffffffffffffffffn ||
            !Number.isInteger(bound) ||
            bound < 512 ||
            bound > SIPBRIDGE_MAX_ENVELOPE_BYTES ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 5000
        ) {
            throw new Error('invalid sipbridge connection options');
        }
        const files = await Promise.all([readFile(options.certificateFile), readFile(options.keyFile), readFile(options.serverTrustFile)]);
        const [cert, key, ca] = files;
        const socket = new WebSocket(url, SIPBRIDGE_SUBPROTOCOL, {
            cert,
            key,
            ca,
            rejectUnauthorized: true,
            ...(options.serverName ? { servername: options.serverName } : {}),
            handshakeTimeout: timeout,
            maxPayload: bound,
            perMessageDeflate: false,
            followRedirects: false
        });
        const client = new SipbridgeControlClient(socket, options);
        await client.negotiate(timeout);
        return client;
    }

    get negotiated(): SessionHelloAck {
        if (!this.ack) throw new Error('sipbridge hello is not complete');
        return structuredClone(this.ack);
    }

    private negotiate(timeout: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => fail(new Error('sipbridge hello deadline')), timeout);
            const fail = (error: Error): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.stop('hello-failed');
                reject(error);
            };
            this.socket.once('error', fail);
            this.socket.once('close', () => fail(new Error('sipbridge closed before hello')));
            this.socket.once('open', () => {
                if (this.stopped) return;
                if (this.socket.protocol !== SIPBRIDGE_SUBPROTOCOL) {
                    fail(new Error('sipbridge subprotocol mismatch'));
                    return;
                }
                this.send({
                    correlationId: this.helloId,
                    sessionId: '',
                    remainingBudgetMs: 0,
                    payload: {
                        $case: 'hello',
                        hello: {
                            nexus: this.options.process,
                            connectionAttempt: this.options.connectionAttempt,
                            major: 1,
                            minMinor: 0,
                            maxMinor: 0,
                            capabilities: this.options.capabilities ?? [],
                            bounds: { maxEnvelopeBytes: this.bound }
                        }
                    }
                }).catch(fail);
            });
            this.socket.on('message', (data: RawData, binary: boolean) => {
                if (this.stopped) return;
                try {
                    if (binary) throw new Error('sipbridge binary frame');
                    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
                    const envelope = decodeSipbridgeFrame(bytes, this.bound);
                    if (!this.ack) {
                        this.acceptHello(envelope);
                        settled = true;
                        clearTimeout(timer);
                        this.startHeartbeat();
                        resolve();
                    } else this.handle(envelope);
                } catch (error) {
                    if (!settled) fail(error instanceof Error ? error : new Error('invalid sipbridge frame'));
                    else this.stop(protocolCloseReason(error));
                }
            });
        });
    }

    private acceptHello(envelope: Envelope): void {
        if (envelope.payload?.$case !== 'helloAck' || envelope.correlationId !== this.helloId) throw new Error('unexpected sipbridge hello response');
        const ack = envelope.payload.helloAck;
        if (ack.inboundAuthPolicy && !ack.capabilities.includes(SIPBRIDGE_LOCAL_CHALLENGE_CAPABILITY)) {
            throw new Error('unnegotiated sipbridge authentication policy');
        }
        if (
            !isSipbridgeProcess(ack.sipbridge) ||
            !isSipbridgeReference(ack.sessionId) ||
            envelope.sessionId !== ack.sessionId ||
            ack.major !== 1 ||
            ack.minor !== 0 ||
            ack.capabilities.some(value => !(this.options.capabilities ?? []).includes(value)) ||
            (hasSipbridgeStateCapability(ack.capabilities) &&
                (!isSipbridgeStateAuthority(ack.stateAuthority) ||
                    !ack.capabilities.includes(SIPBRIDGE_DIRECTORY_RECONCILE_CAPABILITY) ||
                    !ack.capabilities.includes(SIPBRIDGE_COMPLETION_RELAY_CAPABILITY))) ||
            !ack.bounds ||
            !Number.isInteger(ack.bounds.maxEnvelopeBytes) ||
            ack.bounds.maxEnvelopeBytes < 512 ||
            ack.bounds.maxEnvelopeBytes > this.bound ||
            ack.heartbeatIntervalMs < 1 ||
            ack.heartbeatIntervalMs > 60000 ||
            ack.heartbeatTimeoutMs < 2 * ack.heartbeatIntervalMs ||
            ack.heartbeatTimeoutMs > 120000
        ) {
            throw new Error('invalid sipbridge negotiation');
        }
        if (ack.capabilities.includes(SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY)) {
            if (!hasSipbridgeStateCapability(ack.capabilities)) throw new Error('native completion requires state capability');
            const lease = ack.applicationLease;
            if (
                !lease ||
                !isSipbridgeProcess(lease.application) ||
                lease.application.instanceId !== this.options.process.instanceId ||
                lease.application.epoch !== this.options.process.epoch ||
                !isSipbridgeStateAuthority(lease.authority) ||
                !ack.stateAuthority ||
                ack.stateAuthority.schemaVersion !== 2 ||
                lease.authority.service !== ack.stateAuthority.service ||
                lease.authority.generation !== ack.stateAuthority.generation ||
                lease.authority.primaryId !== ack.stateAuthority.primaryId ||
                lease.authority.schemaVersion !== ack.stateAuthority.schemaVersion ||
                !isSipbridgeReference(lease.term) ||
                lease.checkedAtMs <= 0n ||
                lease.expiresAtMs > BigInt(Number.MAX_SAFE_INTEGER) ||
                lease.expiresAtMs - lease.checkedAtMs < 30_000n ||
                lease.expiresAtMs - lease.checkedAtMs > 30_500n
            )
                throw new Error('invalid sipbridge application lease');
        }
        this.ack = ack;
        this.session = ack.sessionId;
        this.bound = ack.bounds.maxEnvelopeBytes;
    }

    private handle(envelope: Envelope): void {
        if (this.stopped || envelope.sessionId !== this.session) throw new Error('stale sipbridge session');
        const payload = envelope.payload;
        if (payload?.$case === 'ping') {
            if (!isSipbridgeReference(payload.ping.nonce)) throw new Error('invalid heartbeat');
            this.send({
                correlationId: envelope.correlationId,
                sessionId: this.session,
                remainingBudgetMs: 0,
                payload: { $case: 'pong', pong: payload.ping }
            }).catch(() => this.stop('write-error'));
            return;
        }
        if (payload?.$case === 'pong') {
            if (!this.pendingHeartbeat || payload.pong.nonce !== this.pendingHeartbeat.id || envelope.correlationId !== this.pendingHeartbeat.id)
                throw new Error('unexpected heartbeat reply');
            this.pendingHeartbeat = undefined;
            return;
        }
        if (
            ['reconcileContext', 'reconcileAuthority', 'authorityReceipt'].includes(payload?.$case ?? '') &&
            !hasSipbridgeStateCapability(this.ack?.capabilities)
        )
            throw new Error('state protocol not negotiated');
        if (this.ack?.capabilities.includes(SIPBRIDGE_STAGING_CAPABILITY)) {
            if (
                payload?.$case === 'result' ||
                payload?.$case === 'delivery' ||
                payload?.$case === 'routeResult' ||
                payload?.$case === 'authorityReceipt'
            ) {
                const pending = this.pending.get(envelope.correlationId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(envelope.correlationId);
                    pending.resolve(envelope);
                    return;
                }
                if (this.expired.has(envelope.correlationId)) return;
                throw new Error('unexpected sipbridge operation result');
            }
            if (this.options.onEnvelope && payload?.$case !== 'hello' && payload?.$case !== 'helloAck' && payload?.$case !== 'status') {
                this.options.onEnvelope(this, envelope);
                return;
            }
        }
        throw new Error('unexpected sipbridge message direction');
    }

    private startHeartbeat(): void {
        const ack = this.negotiated;
        this.heartbeat = setInterval(() => {
            if (this.pendingHeartbeat) {
                if (performance.now() - this.pendingHeartbeat.sent >= ack.heartbeatTimeoutMs) this.stop('heartbeat-timeout');
                return;
            }
            const id = randomUUID();
            this.pendingHeartbeat = { id, sent: performance.now() };
            this.send({
                correlationId: id,
                sessionId: this.session,
                remainingBudgetMs: 0,
                payload: { $case: 'ping', ping: { nonce: id } }
            }).catch(() => this.stop('write-error'));
        }, ack.heartbeatIntervalMs);
    }

    async status(status: SessionStatus): Promise<void> {
        if (status.digestChallengePolicy && !this.ack?.capabilities.includes(SIPBRIDGE_LOCAL_CHALLENGE_CAPABILITY)) {
            throw new Error('sipbridge local challenge capability not negotiated');
        }
        if (
            !this.ack?.capabilities.includes(SIPBRIDGE_STAGING_CAPABILITY) &&
            (status.admitCalls || status.admitSubscriptions || status.retainedReady || status.bindingsReady)
        )
            throw new Error('SIP capabilities are not implemented');
        await this.send({
            correlationId: randomUUID(),
            sessionId: this.session,
            remainingBudgetMs: 0,
            payload: { $case: 'status', status }
        });
    }

    private async send(envelope: Envelope): Promise<void> {
        if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('sipbridge session closed'));
        const frame = encodeSipbridgeFrame(envelope, this.bound);
        // No application queue: session control messages are small and bounded.
        if (this.pendingWrites >= 256 || this.socket.bufferedAmount + Buffer.byteLength(frame) > 1024 * 1024) {
            this.stop('write-capacity');
            return Promise.reject(new Error('sipbridge write capacity'));
        }
        this.pendingWrites++;
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.stop('write-timeout');
                    reject(new Error('sipbridge write deadline'));
                }, 2000);
                this.socket.send(frame, { binary: false }, error => {
                    clearTimeout(timer);
                    if (error) reject(error);
                    else resolve();
                });
            });
        } finally {
            this.pendingWrites--;
        }
    }

    async request(payload: NonNullable<Envelope['payload']>, budgetMs = sipbridgeOperationBudget(payload)): Promise<Envelope> {
        if (!this.ack?.capabilities.includes(SIPBRIDGE_STAGING_CAPABILITY)) throw new Error('application protocol not negotiated');
        if (
            ['reconcileContext', 'reconcileAuthority', 'authorityReceipt'].includes(payload.$case) &&
            !hasSipbridgeStateCapability(this.ack.capabilities)
        )
            throw new Error('state protocol not negotiated');
        if (budgetMs > 2000 && !this.ack.capabilities.includes(SIPBRIDGE_COMMAND_BUDGET_CAPABILITY))
            throw new Error('extended command budget not negotiated');
        if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > sipbridgeOperationBudget(payload))
            throw new Error('invalid control operation budget');
        for (const [id, until] of this.expired) if (until <= performance.now()) this.expired.delete(id);
        if (this.pending.size >= 128 || this.expired.size >= 1024) throw new Error('control operation capacity');
        const id = randomUUID();
        const startedAt = performance.now();
        const context = controlContext(payload);
        const diagnostic = {
            operation: payload.$case,
            correlationId: id,
            budgetMs,
            peerInstanceId: diagnosticReference(this.ack.sipbridge?.instanceId),
            sessionId: diagnosticReference(this.session),
            contextId: diagnosticReference(context?.id),
            callIdHash: sipbridgeCallIdHash(context?.state?.callId),
            commandType: payload.$case === 'command' ? payload.command.action?.$case : undefined
        };
        const result = new Promise<Envelope>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.expired.set(id, performance.now() + 300000);
                reject(
                    new SipbridgeControlDeadlineError({
                        ...diagnostic,
                        elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - startedAt)))
                    })
                );
            }, budgetMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        // A session can close while its write callback is still pending. Observe rejection immediately.
        void result.catch(() => undefined);
        try {
            await this.send({
                correlationId: id,
                sessionId: this.session,
                remainingBudgetMs: budgetMs,
                payload
            });
        } catch (error) {
            const pending = this.pending.get(id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
                pending.reject(error instanceof Error ? error : new Error('control write failed'));
            }
        }
        return result;
    }

    async reply(correlationId: string, payload: NonNullable<Envelope['payload']>): Promise<void> {
        if (!this.ack?.capabilities.includes(SIPBRIDGE_STAGING_CAPABILITY)) throw new Error('application protocol not negotiated');
        await this.send({ correlationId, sessionId: this.session, remainingBudgetMs: 0, payload });
    }

    close(): void {
        this.stop();
    }

    private stop(reason: SipbridgeControlCloseReason = 'requested'): void {
        if (this.stopped) return;
        this.stopped = true;
        this.stopReason = reason;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('control session closed; outcome unknown'));
        }
        this.pending.clear();
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.socket.terminate();
    }
}
