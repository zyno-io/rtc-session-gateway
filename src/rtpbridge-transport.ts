import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import type { ConnectionOptions } from 'node:tls';

import type { AxiosRequestConfig } from 'axios';
import type { ClientOptions } from 'ws';

export class RtpbridgeTransport {
    private secret?: Buffer;
    private ca?: Buffer;
    private agent?: Agent;
    private agents = new Map<string, Agent>();

    constructor(private options: { hmacSecretFile?: string; caFile?: string; servername?: string } = {}) {
        if (options.hmacSecretFile) {
            const raw = readFileSync(options.hmacSecretFile);
            let length = raw.length;
            while (length && (raw[length - 1] === 10 || raw[length - 1] === 13)) length--;
            this.secret = raw.subarray(0, length);
            if (length < 32) throw new Error('RTPBRIDGE_AUTH_HMAC_SECRET_FILE must contain at least 32 bytes');
        }
        if (options.caFile) this.ca = readFileSync(options.caFile);
        if (this.ca || options.servername) {
            this.agent = new Agent({ ca: this.ca, servername: options.servername });
        }
    }

    websocketOptions(url: string, servername = this.options.servername): ClientOptions & Pick<ConnectionOptions, 'servername'> {
        return { headers: this.headers('GET', url), ca: this.ca, servername };
    }

    httpOptions(method: string, url: string, servername = this.options.servername): AxiosRequestConfig {
        // Sign the exact target sent to the selected backend. A redirect needs
        // a new signature and must not inherit administrative authorization.
        let agent = this.agent;
        if (servername && servername !== this.options.servername) {
            agent = this.agents.get(servername);
            if (!agent) {
                if (this.agents.size >= 256) {
                    const idle = [...this.agents.entries()].find(([, candidate]) =>
                        Object.values(candidate.sockets).every(sockets => !sockets?.length)
                    );
                    if (!idle) throw new Error('All backend TLS profiles are busy');
                    idle[1].destroy();
                    this.agents.delete(idle[0]);
                }
                agent = new Agent({ ca: this.ca, servername });
                this.agents.set(servername, agent);
            }
        }
        return { headers: this.headers(method, url), httpsAgent: agent, maxRedirects: 0, proxy: false };
    }

    destroy() {
        this.agent?.destroy();
        for (const agent of this.agents.values()) agent.destroy();
        this.agents.clear();
    }

    private headers(method: string, url: string): Record<string, string> {
        if (!this.secret) return {};
        const target = new URL(url);
        const timestamp = Math.floor(Date.now() / 1000);
        const canonical = `rtpbridge-auth-v1\n${timestamp}\n${method}\n${target.pathname}${target.search}`;
        const signature = createHmac('sha256', this.secret).update(canonical).digest('base64url');
        return { Authorization: `HMAC-SHA256 ${timestamp}:${signature}` };
    }
}
