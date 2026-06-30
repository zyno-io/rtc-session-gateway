import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

import type { GatewayConfig } from './config';
import { BaseLogger } from './logger';
import { RtpbridgeClient } from './rtpbridge-client';

export interface RtpbridgeBackend {
    id: string;
    url: string;
    httpUrl: string;
}

export interface MediaServerResolver {
    resolveSrv(name: string): Promise<Array<{ name: string }>>;
    resolve4(name: string): Promise<string[]>;
}

const CALL_BACKEND_TTL_MS = 4 * 60 * 60 * 1000;

export class MediaBackendNotFoundError extends Error { }

export class MediaServerManager {
    private logger = BaseLogger.child({ ns: 'MediaServerManager' });
    private callToBackend = new Map<string, { backendId: string; createdAt: number; refs: number }>();
    private nextBackendIndex = 0;
    private sweepTimer: NodeJS.Timeout;
    isCallActive?: (callId: string) => boolean;

    constructor(
        private config: Pick<
            GatewayConfig,
            'RTPBRIDGE_HOST' | 'RTPBRIDGE_PORT' | 'RTPBRIDGE_SRV_PORT_NAME' | 'RTPBRIDGE_REQUEST_TIMEOUT_MS' | 'RTPBRIDGE_CONNECTION_TIMEOUT_MS'
        >,
        private resolver: MediaServerResolver = dns
    ) {
        this.sweepTimer = setInterval(() => this.sweepStaleEntries(), 10 * 60 * 1000);
    }

    async createClient(options?: { backendId?: string; callId?: string }) {
        const backend = await this.pickBackend(options);
        if (options?.callId) this.registerCall(options.callId, backend.id);
        return new RtpbridgeClient({
            url: backend.url,
            backendId: backend.id,
            timeoutMs: this.config.RTPBRIDGE_REQUEST_TIMEOUT_MS,
            connectionTimeoutMs: this.config.RTPBRIDGE_CONNECTION_TIMEOUT_MS
        });
    }

    async pickBackendForCall(callId: string) {
        const existing = this.callToBackend.get(callId);
        if (existing) return existing.backendId;
        const backend = await this.pickBackend();
        this.pinCall(callId, backend.id);
        return backend.id;
    }

    registerCall(callId: string, backendId: string) {
        const existing = this.callToBackend.get(callId);
        if (existing?.backendId === backendId) {
            existing.refs++;
            existing.createdAt = Date.now();
            return;
        }
        this.callToBackend.set(callId, { backendId, createdAt: Date.now(), refs: 1 });
    }

    unregisterCall(callId: string, backendId?: string) {
        const existing = this.callToBackend.get(callId);
        if (!existing) return;
        if (backendId && existing.backendId !== backendId) return;
        if (existing.refs > 1) {
            existing.refs--;
            existing.createdAt = Date.now();
            return;
        }
        this.callToBackend.delete(callId);
    }

    getBackendForCall(callId: string) {
        return this.callToBackend.get(callId)?.backendId;
    }

    destroy() {
        clearInterval(this.sweepTimer);
    }

    async resolveBackends(): Promise<RtpbridgeBackend[]> {
        const host = this.requireHost();
        const port = this.config.RTPBRIDGE_PORT;

        if (isIP(host)) return [backendFromHost(host, port)];

        const srvName = `_${this.config.RTPBRIDGE_SRV_PORT_NAME}._tcp.${host}`;
        try {
            const records = await this.resolver.resolveSrv(srvName);
            if (records.length) {
                return records
                    .map(record => record.name.replace(/\.$/, ''))
                    .sort()
                    .map(name => backendFromHost(name, port));
            }
            this.logger.warn({ host, srvName }, 'SRV lookup returned no records, falling back to A records');
        } catch (err) {
            this.logger.warn({ err, host, srvName }, 'SRV lookup failed, falling back to A records');
        }

        try {
            const ips = await this.resolver.resolve4(host);
            return ips.sort().map(ip => backendFromHost(ip, port));
        } catch (err) {
            this.logger.warn({ err, host }, 'DNS resolution failed, using hostname directly');
            return [backendFromHost(host, port)];
        }
    }

    async resolveBackend(backendId: string): Promise<RtpbridgeBackend> {
        const backends = await this.resolveBackends();
        const backend = backends.find(candidate => candidate.id === backendId);
        if (!backend) throw new MediaBackendNotFoundError(`rtpbridge backend ${backendId} not found`);
        return backend;
    }

    private async pickBackend(options?: { backendId?: string; callId?: string }) {
        const backends = await this.resolveBackends();
        const preferredId = options?.backendId ?? (options?.callId ? this.callToBackend.get(options.callId)?.backendId : undefined);
        return this.selectBackend(backends, preferredId);
    }

    private selectBackend(backends: RtpbridgeBackend[], preferredId?: string): RtpbridgeBackend {
        if (!backends.length) {
            const host = this.requireHost();
            return backendFromHost(host, this.config.RTPBRIDGE_PORT);
        }

        if (preferredId) {
            const preferred = backends.find(backend => backend.id === preferredId);
            if (preferred) return preferred;
            this.logger.warn({ preferredId }, 'Preferred rtpbridge backend not found, using round-robin');
        }

        const backend = backends[this.nextBackendIndex % backends.length];
        this.nextBackendIndex = (this.nextBackendIndex + 1) % backends.length;
        return backend;
    }

    private sweepStaleEntries() {
        const now = Date.now();
        for (const [callId, entry] of this.callToBackend) {
            if (entry.refs > 0) continue;
            if (now - entry.createdAt <= CALL_BACKEND_TTL_MS) continue;
            if (this.isCallActive?.(callId)) continue;
            this.callToBackend.delete(callId);
        }
    }

    private pinCall(callId: string, backendId: string) {
        const existing = this.callToBackend.get(callId);
        if (existing?.backendId === backendId) {
            existing.createdAt = Date.now();
            return;
        }
        this.callToBackend.set(callId, { backendId, createdAt: Date.now(), refs: 0 });
    }

    private requireHost() {
        if (!this.config.RTPBRIDGE_HOST) {
            throw new Error('RTPBRIDGE_HOST is required for media commands');
        }
        return this.config.RTPBRIDGE_HOST;
    }
}

function backendFromHost(host: string, port: number): RtpbridgeBackend {
    return {
        id: host,
        url: `ws://${host}:${port}`,
        httpUrl: `http://${host}:${port}`
    };
}
