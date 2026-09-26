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
export interface EndpointCatalogStatus {
    valid: boolean;
    eligibleBackends: number;
    revision?: string;
    validUntil?: string;
    error?: string;
}
export interface EndpointCatalog {
    schemaVersion: 1;
    revision: string;
    validUntil?: string;
    backends: MediaBackend[];
}
function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
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
function endpoint(value: unknown, label: string, scheme: 'ws' | 'http', allowPlaintext: boolean) {
    const entry = object(value, label);
    const url = new URL(boundedString(entry.url, label + '.url', 2048));
    if (url.protocol !== scheme + 's:' && !(allowPlaintext && url.protocol === scheme + ':')) throw new Error(label + ' requires a secure URL');
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
        throw new Error(label + ' requires a root URL without credentials');
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
        const host = match[2].startsWith('[') ? match[2].slice(1, -1) : match[2];
        if (!validHost(host)) throw new Error('Invalid ICE hostname or address');
        return url;
    });
}
export function parseEndpointCatalog(value: unknown, allowPlaintext = false): EndpointCatalog {
    const source = object(value, 'catalog');
    if (source.schemaVersion !== 1) throw new Error('Unsupported endpoint catalog schema version');
    const revision = boundedString(source.revision, 'revision', 127);
    const validUntil = source.validUntil === undefined ? undefined : boundedString(source.validUntil, 'validUntil');
    if (validUntil && !Number.isFinite(Date.parse(validUntil))) throw new Error('Invalid catalog expiry');
    if (!Array.isArray(source.backends) || source.backends.length > 128) throw new Error('Catalog must contain at most 128 backends');
    const ids = new Set<string>();
    const backends = source.backends.map((value, index): MediaBackend => {
        const entry = object(value, 'backend ' + index);
        const id = boundedString(entry.id, 'backend ID', 127);
        if (!/^[a-zA-Z0-9._:-]+$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate backend ID');
        ids.add(id);
        if (typeof entry.acceptNew !== 'boolean') throw new Error('Backend acceptNew must be boolean');
        const control = endpoint(entry.control, 'control', 'ws', allowPlaintext);
        const recordings =
            entry.recordings === undefined
                ? { url: control.url.replace(/^ws/, 'http'), serverName: control.serverName }
                : endpoint(entry.recordings, 'recordings', 'http', allowPlaintext);
        const turn = entry.turn === undefined ? undefined : object(entry.turn, 'turn');
        return {
            id,
            url: control.url,
            httpUrl: recordings.url,
            acceptNew: entry.acceptNew,
            serverName: control.serverName,
            recordingServerName: recordings.serverName,
            turnUrls: turn ? parseIceUrls(turn.urls) : undefined
        };
    });
    return { schemaVersion: 1, revision, validUntil, backends };
}
/** Rejected replacements never extend the last accepted view's original expiry. */
export class FileEndpointCatalog {
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
        const valid = !!this.view && (!this.view.validUntil || Date.parse(this.view.validUntil) > this.now());
        return {
            valid,
            revision: this.view?.revision,
            validUntil: this.view?.validUntil,
            eligibleBackends: valid ? this.view!.backends.filter(backend => backend.acceptNew).length : 0,
            error: this.error,
            backends: this.view?.backends ?? []
        };
    }
    get status(): EndpointCatalogStatus {
        const { backends: _backends, ...status } = this.snapshot;
        return status;
    }
    get backends(): MediaBackend[] {
        return this.snapshot.backends;
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
            if (candidate.validUntil && Date.parse(candidate.validUntil) <= this.now()) throw new Error('Endpoint catalog replacement has expired');
            this.view = candidate;
            this.signature = signature;
            this.error = undefined;
            this.logger.info({ revision: candidate.revision, count: candidate.backends.length }, 'Accepted endpoint catalog');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message !== this.error) this.logger.warn({ error: message }, 'Rejected endpoint catalog update');
            this.error = message;
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
    }
}
