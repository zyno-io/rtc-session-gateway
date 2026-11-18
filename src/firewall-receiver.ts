import http from 'node:http';
import { FIREWALL_MAX_BYTES } from './firewall-contract';
import type { FirewallReconciler } from './firewall-reconciler';
import { bearerMatches } from './firewall-auth';

export function createFirewallHandler(reconciler: FirewallReconciler, token: string): http.RequestListener {
    let inFlight = 0;
    return (req, res) => {
        if (!bearerMatches(req.headers.authorization, token)) {
            res.writeHead(401).end();
            req.resume();
            return;
        }
        if (req.method === 'GET' && req.url === '/v1/status') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reconciler.state));
            return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/snapshot') {
            res.writeHead(404).end();
            req.resume();
            return;
        }
        if (inFlight >= 2) {
            res.writeHead(503).end();
            req.resume();
            return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
            res.writeHead(415).end();
            req.resume();
            return;
        }
        inFlight++;
        let finished = false;
        const finish = () => {
            if (!finished) {
                finished = true;
                inFlight--;
            }
        };
        const timer = setTimeout(() => {
            finish();
            req.destroy();
        }, 1000);
        res.once('close', () => {
            clearTimeout(timer);
            finish();
        });
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('error', () => {
            clearTimeout(timer);
            finish();
        });
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > FIREWALL_MAX_BYTES) {
                res.writeHead(413).end();
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            clearTimeout(timer);
            try {
                reconciler.accept(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                res.writeHead(409).end();
                return;
            }
            // Acceptance is separate from apply; a slow kernel must not stall the publisher.
            res.writeHead(200).end();
            reconciler.schedule();
        });
    };
}
