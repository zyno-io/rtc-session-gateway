import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { parseControlMessage, type ControlRequest, type ControlEvent } from '../control-protocol';

export class AcceptanceError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}
export interface OwnerConnection {
    request(method: string, params: unknown): Promise<any>;
    close?(): void;
}
/** Test-only public owner client. Lost operations are never replayed. */
export class AcceptanceClient extends EventEmitter implements OwnerConnection {
    private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private socket: WebSocket;
    private ready = Promise.withResolvers<void>();
    readonly connected = this.ready.promise;
    private closed = false;
    constructor(url: string, token: string, options: { servername?: string; ca?: Buffer; timeoutMs?: number } = {}) {
        super();
        const connectionOptions = {
            headers: { Authorization: `Bearer ${token}` },
            servername: options.servername,
            ca: options.ca,
            handshakeTimeout: 10000,
            maxPayload: 1048576,
            perMessageDeflate: false,
            followRedirects: false
        };
        this.socket = new WebSocket(url, connectionOptions);
        const startup = setTimeout(() => {
            this.ready.reject(new AcceptanceError('CONNECT_DEADLINE'));
            this.close();
        }, 10000);
        this.connected.finally(() => clearTimeout(startup)).catch(() => undefined);
        this.socket.on('message', (bytes, binary) => {
            try {
                if (binary) throw new AcceptanceError('PROTOCOL_ERROR');
                const frame = parseControlMessage(JSON.parse(bytes.toString()));
                if (frame.type === 'response') {
                    const waiter = this.pending.get(frame.id);
                    if (!waiter) return;
                    this.pending.delete(frame.id);
                    clearTimeout(waiter.timer);
                    if (frame.ok) waiter.resolve(frame.result);
                    else waiter.reject(new AcceptanceError(/^[A-Z_]{1,64}$/.test(frame.error?.code ?? '') ? frame.error!.code : 'RPC_ERROR'));
                } else if (frame.type === 'request') this.emit('request', frame as ControlRequest);
                else {
                    if (frame.event === 'control.connected') this.ready.resolve();
                    this.emit('event', frame as ControlEvent);
                }
            } catch {
                this.close();
            }
        });
        this.socket.on('error', () => this.close());
        this.socket.on('close', () => this.close());
        this.timeoutMs = options.timeoutMs ?? 45000;
    }
    private timeoutMs: number;
    request(method: string, params: unknown): Promise<any> {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new AcceptanceError('OWNER_UNAVAILABLE'));
        if (this.pending.size >= 32 || this.socket.bufferedAmount > 1048576) return Promise.reject(new AcceptanceError('OWNER_CAPACITY'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AcceptanceError('RPC_OUTCOME_UNKNOWN'));
                this.close();
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ type: 'request', id, method, params }), error => {
                if (error) this.close();
            });
        });
    }
    respond(id: string, result: unknown) {
        if (!this.closed && this.socket.readyState === WebSocket.OPEN)
            this.socket.send(JSON.stringify({ type: 'response', id, ok: true, result }), error => {
                if (error) this.close();
            });
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        this.ready.reject(new AcceptanceError('OWNER_DISCONNECTED'));
        for (const waiter of this.pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new AcceptanceError('RPC_OUTCOME_UNKNOWN'));
        }
        this.pending.clear();
        this.socket.terminate();
        this.emit('disconnected');
    }
}
