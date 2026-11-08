import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { BaseLogger } from './logger';

export interface MediaBackend {
    id: string;
    url: string;
    httpUrl: string;
    acceptNew?: boolean;
    serverName?: string;
    recordingServerName?: string;
    turnUrls?: string[];
}
export interface SignalingBackend {
    id: string;
    url: string;
    serverName: string;
    acceptNew: boolean;
}
export interface EndpointCatalogStatus {
    valid: boolean;
    eligibleBackends: number;
    revision?: string;
    validUntil?: string;
    error?: string;
}
export interface CatalogSection<T> {
    revision: string;
    validUntil: string;
    backends: T[];
}
export interface EndpointCatalog {
    schemaVersion: 2;
    signaling: CatalogSection<SignalingBackend>;
    media: CatalogSection<MediaBackend>;
}
function object(value: unknown, label: string, fields?: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
    if (fields && Object.keys(value).some(key => !fields.includes(key))) throw new Error(label + ' has unknown fields');
    return value as Record<string, unknown>;
}
function boundedString(value: unknown, label: string, max = 253): string {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\s\x00-\x1f]/.test(value))
        throw new Error(label + ' must be a bounded nonempty string');
    return value;
}
function validHost(value: string): boolean {
    return !!isIP(value) || (value.length <= 253 && value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)));
}
function endpoint(value: unknown, label: string, scheme: 'ws' | 'http', allowPlaintext: boolean, path = '/') {
    const entry = object(value, label, ['url', 'tlsServerName']);
    const url = new URL(boundedString(entry.url, label + '.url', 2048));
    if (url.protocol !== scheme + 's:' && !(allowPlaintext && url.protocol === scheme + ':')) throw new Error(label + ' requires a secure URL');
    if (url.pathname !== path || url.search || url.hash || url.username || url.password)
        throw new Error(label + ' requires the canonical path without credentials');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!validHost(host)) throw new Error('Invalid endpoint host');
    const serverName = entry.tlsServerName === undefined ? undefined : boundedString(entry.tlsServerName, label + '.tlsServerName');
    if (serverName && !validHost(serverName)) throw new Error(label + ' has an invalid TLS name');
    return { url: url.toString(), serverName };
}
export function parseIceUrls(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('TURN URLs must be a nonempty array of at most 32 URLs');
    return value.map(candidate => {
        const url = boundedString(candidate, 'TURN URL', 1024);
        const match = /^(stun|turn|turns):(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/.exec(url);
        if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) throw new Error('Invalid ICE server URL');
        if (!validHost(match[2].replace(/^\[|\]$/g, ''))) throw new Error('Invalid ICE hostname or address');
        return url;
    });
}
export function parseEndpointCatalog(value: unknown, allowPlaintext = false): EndpointCatalog {
    const source = object(value, 'catalog', ['schemaVersion', 'signaling', 'media']);
    if (source.schemaVersion !== 2) throw new Error('Unsupported endpoint catalog schema version');
    function section<T>(value: unknown, limit: number, project: (entry: Record<string, unknown>, id: string) => T): CatalogSection<T> {
        const source = object(value, 'section', ['revision', 'validUntil', 'backends']);
        const revision = boundedString(source.revision, 'revision', 64);
        if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid section revision');
        const validUntil = boundedString(source.validUntil, 'validUntil');
        if (!/^\d{4}-\d\d-\d\dT/.test(validUntil) || !Number.isFinite(Date.parse(validUntil))) throw new Error('Invalid section expiry');
        if (!Array.isArray(source.backends) || source.backends.length > limit) throw new Error('Invalid backend count');
        const ids = new Set<string>();
        const backends = source.backends.map(value => {
            const entry = object(value, 'backend', ['id', 'acceptNew', 'control', ...(limit === 1 ? [] : ['recordings', 'turn'])]);
            const id = boundedString(entry.id, 'backend ID', 127);
            if (!/^[a-zA-Z0-9._:-]+$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate backend ID');
            ids.add(id);
            if (typeof entry.acceptNew !== 'boolean') throw new Error('Backend acceptNew must be boolean');
            return project(entry, id);
        });
        return { revision, validUntil, backends };
    }
    return {
        schemaVersion: 2,
        signaling: section(source.signaling, 1, (entry, id) => {
            const control = endpoint(entry.control, 'signaling control', 'ws', false, '/v1/control');
            if (!control.serverName) throw new Error('Signaling requires tlsServerName');
            return {
                id,
                url: control.url,
                serverName: control.serverName,
                acceptNew: entry.acceptNew as boolean
            };
        }),
        media: section(source.media, 128, (entry, id) => {
            const control = endpoint(entry.control, 'media control', 'ws', allowPlaintext);
            const recordings =
                entry.recordings === undefined
                    ? { url: control.url.replace(/^ws/, 'http'), serverName: control.serverName }
                    : endpoint(entry.recordings, 'recordings', 'http', allowPlaintext);
            const turn = entry.turn === undefined ? undefined : object(entry.turn, 'turn', ['urls']);
            return {
                id,
                url: control.url,
                httpUrl: recordings.url,
                acceptNew: entry.acceptNew as boolean,
                serverName: control.serverName,
                recordingServerName: recordings.serverName,
                turnUrls: turn ? parseIceUrls(turn.urls) : undefined
            };
        })
    };
}
/** Bad replacements cannot renew either section. Expired sections are valid withdrawal documents. */
export class FileRtcEndpointCatalog {
    private view?: EndpointCatalog;
    private error?: string;
    private signature?: string;
    private timer: NodeJS.Timeout;
    private logger = BaseLogger.child({ ns: 'EndpointCatalog' });
    constructor(
        private path: string,
        private allowPlaintext = false,
        private now: () => number = Date.now
    ) {
        this.refresh();
        this.timer = setInterval(() => this.refresh(), 1000);
        this.timer.unref();
    }
    get snapshot() {
        this.refresh();
        const section = <T>(view?: CatalogSection<T>) => {
            const valid = !!view && Date.parse(view.validUntil) > this.now();
            return {
                valid,
                revision: view?.revision,
                validUntil: view?.validUntil,
                error: this.error,
                backends: view?.backends ?? []
            };
        };
        return { signaling: section(this.view?.signaling), media: section(this.view?.media) };
    }
    destroy() {
        clearInterval(this.timer);
    }
    private refresh() {
        let fd: number | undefined;
        try {
            fd = openSync(this.path, 'r');
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Endpoint catalog must be a file of at most 256 KiB');
            const signature = stat.ino + ':' + stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size;
            if (signature === this.signature) return;
            const raw = readFileSync(fd);
            if (raw.length > 256 * 1024) throw new Error('Endpoint catalog exceeds size bound');
            const candidate = parseEndpointCatalog(JSON.parse(raw.toString('utf8')), this.allowPlaintext);
            this.view = candidate;
            this.signature = signature;
            this.error = undefined;
        } catch {
            if (!this.error) this.logger.warn('Rejected endpoint catalog update');
            this.error = 'Endpoint catalog unavailable or invalid';
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
    }
}
/** Media-facing view; signaling expiry cannot accidentally withdraw healthy media. */
export class FileEndpointCatalog {
    private catalog: FileRtcEndpointCatalog;
    constructor(path: string, allowPlaintext = false, now: () => number = Date.now) {
        this.catalog = new FileRtcEndpointCatalog(path, allowPlaintext, now);
    }
    get snapshot() {
        const view = this.catalog.snapshot.media;
        return {
            ...view,
            eligibleBackends: view.valid ? view.backends.filter(backend => backend.acceptNew).length : 0
        };
    }
    get status(): EndpointCatalogStatus {
        const { backends: _, ...status } = this.snapshot;
        return status;
    }
    get backends(): MediaBackend[] {
        return this.snapshot.backends;
    }
    destroy() {
        this.catalog.destroy();
    }
}
