import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import { scrubControlError, scrubRtpbridgeEvent, scrubRtpbridgeRequest, scrubRtpbridgeResponse } from './control-log';
import { BaseLogger } from './logger';
import type { RtpOfferOptions } from './media-controller';

export interface RtpbridgeClientOptions {
    url: string;
    backendId?: string;
    timeoutMs?: number;
    connectionTimeoutMs?: number;
}

export interface FileEndpointParams {
    source: string;
    loopCount?: number | null;
    startMs?: number;
    timeoutMs?: number;
    cacheTtlSecs?: number;
    shared?: boolean;
    headers?: Record<string, string>;
}

export interface RecordingResult {
    filePath: string;
    durationMs: number;
    packets: number;
}

export interface VadOptions {
    silenceIntervalMs?: number;
    speechThreshold?: number;
}

export interface RtpbridgeServerInfo {
    hostname: string;
    version?: string;
    mediaIp: string | string[];
}

export interface RtpbridgeDtmfEvent {
    endpointId: string;
    digit: string;
    durationMs: number;
    sensitive?: boolean;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
}

export class RtpbridgeClient extends EventEmitter {
    private logger = BaseLogger.child({ ns: 'RtpbridgeClient' });
    private ws: WebSocket;
    private ready: Promise<void>;
    private pending = new Map<string, PendingRequest>();
    private closeHandlers: Array<() => void> = [];
    private intentionalClose = false;
    private pingInterval?: NodeJS.Timeout;

    constructor(private options: RtpbridgeClientOptions) {
        super();
        this.ws = new WebSocket(options.url);
        this.ws.on('message', data => this.handleMessage(data.toString()));
        this.ws.on('error', err => {
            this.rejectAllPending(err);
            this.fireCloseHandlers();
        });
        this.ws.on('close', () => {
            this.rejectAllPending(new Error('rtpbridge socket closed'));
            this.fireCloseHandlers();
        });

        const connectionTimeoutMs = options.connectionTimeoutMs ?? 5_000;
        this.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.ws.close();
                reject(new Error(`rtpbridge connection timeout after ${connectionTimeoutMs}ms`));
            }, connectionTimeoutMs);

            this.ws.once('open', () => {
                clearTimeout(timer);
                this.logger.info({ url: options.url, backendId: options.backendId }, 'rtpbridge socket open');
                resolve();
            });
            this.ws.once('error', err => {
                clearTimeout(timer);
                reject(err);
            });
        });
        this.ready.catch(err => this.logger.debug({ err }, 'rtpbridge ready promise rejected'));
        this.ready
            .then(() => {
                this.pingInterval = setInterval(() => {
                    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
                }, 30_000);
            })
            .catch(() => {});
    }

    get backendId() {
        return this.options.backendId;
    }

    get backendHost() {
        try {
            return new URL(this.options.url).hostname;
        } catch {
            return undefined;
        }
    }

    async getServerInfo(): Promise<RtpbridgeServerInfo> {
        return this.sendRequest('server.info', {});
    }

    async createSession(): Promise<string> {
        const response = await this.sendRequest('session.create', {});
        if (typeof response.sessionId !== 'string' || !response.sessionId) {
            throw new Error('session.create returned no sessionId');
        }
        return response.sessionId;
    }

    async destroySession(sessionId: string): Promise<void> {
        await this.sendRequest('session.destroy', { sessionId });
    }

    async createWebrtcOffer(sessionId: string, params: { direction?: string } = {}): Promise<{ endpointId: string; sdpOffer: string }> {
        return this.sendRequest('endpoint.webrtc.create_offer', { sessionId, ...params });
    }

    async createWebrtcFromOffer(sessionId: string, params: { sdp: string; direction?: string }): Promise<{ endpointId: string; sdpAnswer: string }> {
        return this.sendRequest('endpoint.webrtc.create_from_offer', { sessionId, ...params });
    }

    async acceptWebrtcAnswer(endpointId: string, sdp: string, offerGeneration?: number): Promise<void> {
        await this.sendRequest('endpoint.webrtc.accept_answer', {
            endpointId,
            sdp,
            ...(offerGeneration !== undefined ? { offerGeneration } : {})
        });
    }

    async acceptWebrtcOffer(endpointId: string, sdp: string): Promise<{ sdpAnswer: string }> {
        return this.sendRequest('endpoint.webrtc.accept_offer', { endpointId, sdp });
    }

    async iceRestart(endpointId: string): Promise<{ sdpOffer: string; offerGeneration: number }> {
        return this.sendRequest('endpoint.webrtc.ice_restart', { endpointId });
    }

    async createRtpOffer(
        sessionId: string,
        params: RtpOfferOptions = {}
    ): Promise<{ endpointId: string; sdpOffer: string }> {
        return this.sendRequest('endpoint.rtp.create_offer', { sessionId, ...params });
    }

    async createRtpFromOffer(sessionId: string, params: { sdp: string; direction?: string }): Promise<{ endpointId: string; sdpAnswer: string }> {
        return this.sendRequest('endpoint.rtp.create_from_offer', { sessionId, ...params });
    }

    async acceptRtpAnswer(endpointId: string, sdp: string): Promise<void> {
        await this.sendRequest('endpoint.rtp.accept_answer', { endpointId, sdp });
    }

    async rtpReinvite(endpointId: string, sdp: string): Promise<{ sdpAnswer: string }> {
        return this.sendRequest('endpoint.rtp.reinvite', { endpointId, sdp });
    }

    async bridgeSession(
        targetSessionId: string,
        params: { direction?: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive' } = {}
    ): Promise<{ endpointId: string; targetEndpointId: string }> {
        return this.sendRequest('session.bridge', { targetSessionId, ...params });
    }

    async injectDtmf(endpointId: string, digit: string): Promise<void> {
        await this.sendRequest('endpoint.dtmf.inject', { endpointId, digit });
    }

    async setSensitiveDtmf(endpointId: string, enabled: boolean): Promise<void> {
        await this.sendRequest('endpoint.dtmf.set_sensitive', { endpointId, enabled });
    }

    async createFileEndpoint(sessionId: string, params: FileEndpointParams): Promise<{ endpointId: string }> {
        return this.sendRequest('endpoint.create_with_file', { sessionId, ...params });
    }

    async createToneEndpoint(sessionId: string, params: { tone: string; frequency?: number; durationMs?: number }): Promise<{ endpointId: string }> {
        return this.sendRequest('endpoint.create_tone', { sessionId, ...params });
    }

    async removeEndpoint(endpointId: string): Promise<void> {
        await this.sendRequest('endpoint.remove', { endpointId });
    }

    async updateDirection(endpointId: string, direction: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive'): Promise<void> {
        await this.sendRequest('endpoint.update_direction', { endpointId, direction });
    }

    async startRecording(
        sessionId: string,
        params: { endpointId?: string; filePath: string; recordOutbound?: boolean }
    ): Promise<{ recordingId: string }> {
        return this.sendRequest('recording.start', { sessionId, ...params });
    }

    async stopRecording(recordingId: string): Promise<RecordingResult> {
        return this.sendRequest('recording.stop', { recordingId });
    }

    async startVad(endpointId: string, options?: VadOptions): Promise<void> {
        await this.sendRequest('vad.start', { endpointId, ...options });
    }

    async stopVad(endpointId: string): Promise<void> {
        await this.sendRequest('vad.stop', { endpointId });
    }

    onClose(handler: () => void) {
        this.closeHandlers.push(handler);
    }

    close() {
        this.intentionalClose = true;
        this.closeHandlers = [];
        clearInterval(this.pingInterval);
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    }

    private async sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
        await this.ready;
        const id = randomUUID();
        const wireParams = toSnakeCase(params);
        const payload = JSON.stringify({ id, method, params: wireParams });
        this.logger.debug(
            {
                payloadBytes: Buffer.byteLength(payload),
                body: scrubRtpbridgeRequest(id, method, wireParams)
            },
            'Sending rtpbridge request'
        );
        const timeoutMs = this.options.timeoutMs ?? 10_000;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`rtpbridge request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
        });

        try {
            if (this.ws.readyState !== WebSocket.OPEN) throw new Error(`rtpbridge socket is not open (${this.ws.readyState})`);
            this.ws.send(payload, err => {
                if (err) this.rejectPending(id, err);
            });
        } catch (err) {
            this.rejectPending(id, err instanceof Error ? err : new Error(String(err)));
        }

        return promise;
    }

    private handleMessage(raw: string) {
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            this.logger.warn({ error: scrubControlError(err), messageLength: raw.length }, 'Failed to parse rtpbridge message');
            return;
        }

        if (parsed.event) {
            const data = toCamelCase(parsed.data);
            this.logger.debug({ payloadBytes: Buffer.byteLength(raw), body: scrubRtpbridgeEvent(parsed.event, data) }, 'Received rtpbridge event');
            this.emit(parsed.event, data);
            this.emit('rtpbridge.event', { event: parsed.event, data });
            return;
        }

        const pending = this.pending.get(parsed.id);
        if (!pending) {
            this.logger.warn({ body: scrubRtpbridgeResponse(parsed.id, '<unknown>', parsed) }, 'No pending rtpbridge request');
            return;
        }
        this.pending.delete(parsed.id);
        clearTimeout(pending.timer);
        this.logger.debug(
            {
                payloadBytes: Buffer.byteLength(raw),
                body: scrubRtpbridgeResponse(parsed.id, pending.method, parsed)
            },
            'Received rtpbridge response'
        );

        if (parsed.error) {
            const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? JSON.stringify(parsed.error));
            pending.reject(new Error(message));
            return;
        }
        pending.resolve(toCamelCase(parsed.result ?? {}));
    }

    private rejectPending(id: string, err: Error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(err);
    }

    private rejectAllPending(err: Error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(err);
        }
        this.pending.clear();
    }

    private fireCloseHandlers() {
        if (this.intentionalClose) return;
        this.intentionalClose = true;
        clearInterval(this.pingInterval);
        const handlers = this.closeHandlers;
        this.closeHandlers = [];
        for (const handler of handlers) handler();
    }
}

function toSnakeCase(obj: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        out[key.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)] = value;
    }
    return out;
}

function toCamelCase(input: any): any {
    if (input == null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(toCamelCase);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        out[key.replace(/_([a-z])/g, (_match, char) => char.toUpperCase())] = toCamelCase(value);
    }
    return out;
}
