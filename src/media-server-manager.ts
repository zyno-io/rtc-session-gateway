import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

import type { GatewayConfig } from './config';
import { BaseLogger } from './logger';
import { RtpbridgeClient } from './rtpbridge-client';
import { RtpbridgeTransport } from './rtpbridge-transport';
import { FileEndpointCatalog, type MediaBackend } from './endpoint-catalog';

export type RtpbridgeBackend = MediaBackend;

export interface MediaServerResolver {
    resolveSrv(name: string): Promise<Array<{ name: string }>>;
    resolve4(name: string): Promise<string[]>;
}

const CALL_BACKEND_TTL_MS = 4 * 60 * 60 * 1000;

export class MediaBackendNotFoundError extends Error { }
export class MediaBackendUnavailableError extends Error { }

export class MediaServerManager {
    private logger = BaseLogger.child({ ns: 'MediaServerManager' });
    private callToBackend = new Map<string, { backendId: string; createdAt: number; refs: number }>();
    private nextBackendIndex = 0;
    private sweepTimer: NodeJS.Timeout;
    private transport: RtpbridgeTransport;
    private catalog?: FileEndpointCatalog;
    isCallActive?: (callId: string) => boolean;

    constructor(
        private config: Pick<
            GatewayConfig,
            'RTPBRIDGE_HOST' | 'RTPBRIDGE_PORT' | 'RTPBRIDGE_SRV_PORT_NAME' | 'RTPBRIDGE_REQUEST_TIMEOUT_MS' | 'RTPBRIDGE_CONNECTION_TIMEOUT_MS'
        > & Partial<Pick<
            GatewayConfig,
            'RTPBRIDGE_TLS' | 'RTPBRIDGE_AUTH_HMAC_SECRET_FILE' | 'RTPBRIDGE_TLS_CA_FILE' | 'RTPBRIDGE_TLS_SERVERNAME' |
            'RTPBRIDGE_ENDPOINTS_FILE' | 'RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT'
        >>,
        private resolver: MediaServerResolver = dns
    ) {
        const dnsHostname = config.RTPBRIDGE_HOST && !isIP(config.RTPBRIDGE_HOST) ? config.RTPBRIDGE_HOST : undefined;
        this.transport = new RtpbridgeTransport({
            hmacSecretFile: config.RTPBRIDGE_AUTH_HMAC_SECRET_FILE,
            caFile: config.RTPBRIDGE_TLS_CA_FILE,
            servername: config.RTPBRIDGE_TLS_SERVERNAME ?? (config.RTPBRIDGE_TLS ? dnsHostname : undefined)
        });
        if (config.RTPBRIDGE_ENDPOINTS_FILE)
            this.catalog = new FileEndpointCatalog(config.RTPBRIDGE_ENDPOINTS_FILE, config.RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT);
        this.sweepTimer = setInterval(() => this.sweepStaleEntries(), 10 * 60 * 1000);
    }

    async createClient(options?: { backendId?: string; callId?: string }) {
        const backend = await this.pickBackend(options);
        if (options?.callId) this.registerCall(options.callId, backend.id);
        return new RtpbridgeClient({
            url: backend.url,
            backendId: backend.id,
            websocketOptions: this.transport.websocketOptions(backend.url, backend.serverName),
            iceUrls: backend.turnUrls,
            timeoutMs: this.config.RTPBRIDGE_REQUEST_TIMEOUT_MS,
            connectionTimeoutMs: this.config.RTPBRIDGE_CONNECTION_TIMEOUT_MS
        });
    }

    async pickBackendForCall(callId: string) {
        const backend = await this.pickBackend({ callId });
        return backend.id;
    }

    registerCall(callId: string, backendId: string) {
        const existing = this.callToBackend.get(callId);
        if (existing?.backendId === backendId) {
            existing.refs++;
            existing.createdAt = Date.now();
            return;
        }
        if (existing) throw new MediaBackendUnavailableError('Call is pinned to a different backend');
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
        if (this.isCallActive?.(callId)) {
            existing.refs = 0;
            existing.createdAt = Date.now();
        } else this.callToBackend.delete(callId);
    }

    getBackendForCall(callId: string) {
        return this.callToBackend.get(callId)?.backendId;
    }

    destroy() {
        clearInterval(this.sweepTimer);
        this.catalog?.destroy();
        this.transport.destroy();
    }

    getHttpRequestOptions(method: string, url: string, backend?: RtpbridgeBackend) {
        return this.transport.httpOptions(method, url, backend?.recordingServerName);
    }

    get readiness() {
        return (
            this.catalog?.status ?? {
                valid: !!this.config.RTPBRIDGE_HOST,
                eligibleBackends: this.config.RTPBRIDGE_HOST ? 1 : 0
            }
        );
    }

    async resolveBackends(): Promise<RtpbridgeBackend[]> {
        if (this.catalog) return this.catalog.backends;
        const host = this.requireHost();
        const port = this.config.RTPBRIDGE_PORT;

        if (isIP(host)) return [backendFromHost(host, port, this.config.RTPBRIDGE_TLS)];

        const srvName = `_${this.config.RTPBRIDGE_SRV_PORT_NAME}._tcp.${host}`;
        try {
            const records = await this.resolver.resolveSrv(srvName);
            if (records.length) {
                return records
                    .map(record => record.name.replace(/\.$/, ''))
                    .sort()
                    .map(name => backendFromHost(name, port, this.config.RTPBRIDGE_TLS));
            }
            this.logger.warn({ host, srvName }, 'SRV lookup returned no records, falling back to A records');
        } catch (err) {
            this.logger.warn({ err, host, srvName }, 'SRV lookup failed, falling back to A records');
        }

        try {
            const ips = await this.resolver.resolve4(host);
            return ips.sort().map(ip => backendFromHost(ip, port, this.config.RTPBRIDGE_TLS));
        } catch (err) {
            this.logger.warn({ err, host }, 'DNS resolution failed, using hostname directly');
            return [backendFromHost(host, port, this.config.RTPBRIDGE_TLS)];
        }
    }

    async resolveBackend(backendId: string): Promise<RtpbridgeBackend> {
        const backends = await this.resolveBackends();
        const backend = backends.find(candidate => candidate.id === backendId);
        if (!backend) throw new MediaBackendNotFoundError(`rtpbridge backend ${backendId} not found`);
        return backend;
    }

    private async pickBackend(options?: { backendId?: string; callId?: string }) {
        let backends: RtpbridgeBackend[];
        if (this.catalog) {
            const snapshot = this.catalog.snapshot;
            if (!snapshot.valid) throw new MediaBackendUnavailableError('Endpoint catalog is unavailable or expired');
            backends = snapshot.backends;
        } else backends = await this.resolveBackends();
        // Re-read the pin after discovery; concurrent selections must see the first allocation.
        const pinnedId = options?.callId ? this.callToBackend.get(options.callId)?.backendId : undefined;
        if (pinnedId && options?.backendId && pinnedId !== options.backendId)
            throw new MediaBackendUnavailableError('Call is pinned to a different backend');
        const backend = this.selectBackend(backends, pinnedId ?? options?.backendId);
        if (options?.callId) this.pinCall(options.callId, backend.id);
        return backend;
    }

    private selectBackend(backends: RtpbridgeBackend[], preferredId?: string): RtpbridgeBackend {
        if (preferredId) {
            const preferred = backends.find(backend => backend.id === preferredId);
            if (!preferred) throw new MediaBackendNotFoundError('Pinned rtpbridge backend ' + preferredId + ' not found');
            if (preferred.acceptNew === false) throw new MediaBackendUnavailableError('Pinned rtpbridge backend is not admitting sessions');
            return preferred;
        }

        const accepting = backends.filter(backend => backend.acceptNew !== false);
        if (!accepting.length) throw new MediaBackendUnavailableError('No rtpbridge backend accepts new sessions');
        const backend = accepting[this.nextBackendIndex % accepting.length];
        this.nextBackendIndex = (this.nextBackendIndex + 1) % accepting.length;
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

function backendFromHost(host: string, port: number, tls = false): RtpbridgeBackend {
    const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    return {
        id: host,
        url: `${tls ? 'wss' : 'ws'}://${authority}`,
        httpUrl: `${tls ? 'https' : 'http'}://${authority}`
    };
}
