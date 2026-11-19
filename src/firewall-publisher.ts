import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { FIREWALL_MAX_BYTES } from './firewall-contract';
import { BaseLogger } from './logger';
import type { SipFirewall } from './sip-firewall';

export function postFirewallSnapshot(url: string, token: string, body: unknown, caFile?: string): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > FIREWALL_MAX_BYTES) return Promise.reject(new Error('Firewall snapshot exceeds bound'));
    const target = new URL(url);
    return new Promise((resolve, reject) => {
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.request(
            target,
            {
                method: 'POST',
                ca: caFile ? readFileSync(caFile) : undefined,
                headers: {
                    authorization: 'Bearer ' + token,
                    'content-type': 'application/json',
                    'content-length': bytes.length
                }
            },
            res => {
                res.resume();
                res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error('Firewall publisher returned ' + res.statusCode))));
                res.on('error', reject);
            }
        );
        const timer = setTimeout(() => req.destroy(new Error('Firewall publication deadline exceeded')), 1000);
        req.on('close', () => clearTimeout(timer));
        req.on('error', reject);
        req.end(bytes);
    });
}

export class FirewallPublisher {
    private readonly logger = BaseLogger.child({ ns: 'FirewallPublisher' });
    private timer?: NodeJS.Timeout;
    private pending = false;
    private running?: Promise<void>;
    private stopped = false;
    private lastWarning = 0;
    readonly status = { lastSuccess: undefined as string | undefined, errors: 0 };
    private readonly change = () => this.publish();

    constructor(private readonly firewall: SipFirewall) {}

    start(): void {
        this.firewall.on('change', this.change);
        this.timer = setInterval(() => {
            this.firewall.sweep();
            this.publish();
        }, 5000);
        this.timer.unref();
        this.publish();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.firewall.off('change', this.change);
        await this.running;
    }

    private publish(): void {
        if (this.stopped || !this.firewall.config.publisherUrl) return;
        this.pending = true;
        if (!this.running)
            this.running = Promise.resolve()
                .then(() => this.flush())
                .finally(() => {
                    this.running = undefined;
                });
    }

    private async flush(): Promise<void> {
        while (this.pending && !this.stopped) {
            this.pending = false;
            try {
                const snapshot = this.firewall.snapshot();
                // Snapshot expiry/pruning can emit a change while obtaining this same view.
                this.pending = false;
                await postFirewallSnapshot(
                    this.firewall.config.publisherUrl!,
                    this.firewall.config.publisherToken!,
                    snapshot,
                    this.firewall.config.publisherCaFile
                );
                this.status.lastSuccess = new Date().toISOString();
            } catch {
                this.status.errors++;
                if (Date.now() - this.lastWarning >= 30_000) {
                    this.lastWarning = Date.now();
                    this.logger.warn('Firewall publication failed; retaining remote bans until expiry');
                }
                // Retry the latest full view on the periodic tick, never accumulate failed writes.
                return;
            }
        }
    }
}
