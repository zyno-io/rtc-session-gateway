import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AcceptanceClient, AcceptanceError } from './client';
import { AcceptanceOwner } from './owner';
import type { ControlRequest, ControlEvent } from '../control-protocol';

export async function startAcceptance(env: NodeJS.ProcessEnv = process.env) {
    const endpoint = new URL(env.RTC_ACCEPTANCE_CONTROL_URL ?? 'ws://127.0.0.1:3001/control');
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new AcceptanceError('INVALID_CONTROL_URL');
    const route = env.RTC_ACCEPTANCE_ROUTE ?? 'rtc-acceptance';
    const tokenFile = env.RTC_ACCEPTANCE_TOKEN_FILE;
    if (!tokenFile) throw new AcceptanceError('TOKEN_FILE_REQUIRED');
    const token = () => {
        const value = readFileSync(tokenFile, 'utf8').trim();
        if (value.length < 16 || /[\r\n]/.test(value)) throw new AcceptanceError('INVALID_TOKEN_FILE');
        return value;
    };
    token();
    const outbound = env.RTC_ACCEPTANCE_OUTBOUND_URI;
    if (outbound && (!/^sips?:[^\s\r\n]+$/.test(outbound) || outbound.length > 2048)) throw new AcceptanceError('INVALID_OUTBOUND_URI');
    const peers = new Map<string, { client?: AcceptanceClient; owner?: AcceptanceOwner; ready: boolean; connecting: boolean; retryAt: number }>();
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const results: { scenario: string; ok: boolean; at: string; code?: string; checks?: string[]; scope?: string }[] = [];
    let stopping = false,
        discovering = false,
        running = false;
    const report = () => ({
        runId,
        startedAt,
        controllerReady: [...peers.values()].some(peer => peer.ready),
        running,
        instances: [...peers.values()].map(peer => ({
            registered: peer.ready,
            activeCalls: peer.owner?.activeCalls ?? 0,
            counters: peer.owner?.counters
        })),
        scenarios: results
    });
    const discover = async () => {
        if (stopping || discovering) return;
        discovering = true;
        try {
            const addresses =
                env.RTC_ACCEPTANCE_RESOLVE_INSTANCES === 'true'
                    ? (await lookup(endpoint.hostname, { all: true, family: 4 })).map(address => address.address)
                    : [endpoint.hostname];
            if (addresses.length > 16) throw new AcceptanceError('INSTANCE_CAPACITY');
            for (const [address, peer] of peers)
                if (!addresses.includes(address) && !peer.owner?.activeCalls) {
                    peer.client?.close();
                    peers.delete(address);
                }
            for (const address of addresses) {
                const peer = peers.get(address) ?? { ready: false, connecting: false, retryAt: 0 };
                peers.set(address, peer);
                if (peer.client || peer.connecting || peer.retryAt > Date.now()) continue;
                peer.connecting = true;
                void (async () => {
                    let client: AcceptanceClient | undefined;
                    try {
                        const url = new URL(endpoint);
                        url.hostname = address;
                        client = new AcceptanceClient(url.toString(), token(), {
                            servername: endpoint.hostname,
                            ca: env.RTC_ACCEPTANCE_CA_FILE ? readFileSync(env.RTC_ACCEPTANCE_CA_FILE) : undefined
                        });
                        peer.client = client;
                        const owner = new AcceptanceOwner(client, route);
                        peer.owner = owner;
                        client.on('request', (request: ControlRequest) => {
                            void owner
                                .handle(request)
                                .then(result => client!.respond(request.id, result))
                                .catch(() => client!.close());
                        });
                        client.on('event', (event: ControlEvent) => {
                            void owner.event(event).catch(() => {
                                owner.counters.errors++;
                            });
                        });
                        client.once('disconnected', () => {
                            peer.ready = false;
                            peer.client = undefined;
                            peer.retryAt = Date.now() + 2000;
                        });
                        await client.connected;
                        await owner.register();
                        peer.ready = true;
                    } catch {
                        client?.close();
                        peer.client = undefined;
                        peer.retryAt = Date.now() + 2000;
                    } finally {
                        peer.connecting = false;
                    }
                })();
            }
        } catch {
            /* Discovery failure withdraws no existing owner connection. */
        } finally {
            discovering = false;
        }
    };
    const authenticated = (request: IncomingMessage) => {
        const provided = Buffer.from(request.headers.authorization ?? '');
        const expected = Buffer.from('Bearer ' + token());
        return provided.length === expected.length && timingSafeEqual(provided, expected);
    };
    const server = createServer((request, response) => {
        const send = (status: number, body: unknown) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
        };
        if (request.method === 'GET' && request.url === '/healthz') {
            send(200, { ok: true });
            return;
        }
        if (request.method === 'GET' && request.url === '/readyz') {
            send(report().controllerReady && !stopping ? 200 : 503, { ok: report().controllerReady && !stopping });
            return;
        }
        try {
            if (!authenticated(request)) {
                send(401, { error: 'Unauthorized' });
                return;
            }
        } catch {
            send(503, { error: 'TOKEN_UNAVAILABLE' });
            return;
        }
        if (request.method === 'GET' && request.url === '/report') {
            send(200, report());
            return;
        }
        if (request.method !== 'POST' || request.url !== '/run') {
            send(404, { error: 'Not found' });
            return;
        }
        if (running || stopping) {
            send(409, { error: 'BUSY_OR_STOPPING' });
            return;
        }
        running = true;
        void (async () => {
            let scenario = 'invalid';
            try {
                let bytes = 0;
                const chunks: Buffer[] = [];
                for await (const chunk of request) {
                    bytes += chunk.length;
                    if (bytes > 4096) throw new AcceptanceError('BODY_TOO_LARGE');
                    chunks.push(Buffer.from(chunk));
                }
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                scenario = body.scenario;
                if (!['media', 'outbound', 'cancel'].includes(scenario) || Object.keys(body).some(key => key !== 'scenario'))
                    throw new AcceptanceError('INVALID_SCENARIO');
                const peer = [...peers.values()].find(peer => peer.ready && !peer.owner?.counters.draining);
                if (!peer?.owner) throw new AcceptanceError('NO_REGISTERED_INSTANCE');
                const result = await peer.owner.smoke(scenario as 'media' | 'outbound' | 'cancel', outbound);
                const entry = { scenario, ok: true, at: new Date().toISOString(), ...result };
                results.push(entry);
                send(200, entry);
            } catch (error) {
                const entry = {
                    scenario: ['media', 'outbound', 'cancel'].includes(scenario) ? scenario : 'invalid',
                    ok: false,
                    at: new Date().toISOString(),
                    code: error instanceof AcceptanceError ? error.code : 'SCENARIO_FAILED'
                };
                results.push(entry);
                send(503, entry);
            } finally {
                running = false;
                if (results.length > 128) results.splice(0, results.length - 128);
            }
        })();
    });
    server.requestTimeout = 60000;
    server.headersTimeout = 10000;
    server.maxConnections = 32;
    const port = Number(env.RTC_ACCEPTANCE_PORT ?? '3002');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AcceptanceError('INVALID_PORT');
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, env.RTC_ACCEPTANCE_BIND ?? '127.0.0.1', resolve);
    });
    const timer = setInterval(() => {
        void discover();
    }, 2000);
    await discover();
    return {
        server,
        report,
        async stop() {
            stopping = true;
            clearInterval(timer);
            await Promise.race([
                Promise.allSettled([...peers.values()].map(peer => peer.owner?.stop())),
                new Promise(resolve => setTimeout(resolve, 5000).unref())
            ]);
            for (const peer of peers.values()) peer.client?.close();
            await new Promise<void>(resolve => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    };
}
if (require.main === module)
    void startAcceptance()
        .then(controller => {
            let stopping = false;
            for (const signal of ['SIGTERM', 'SIGINT'])
                process.on(signal, () => {
                    if (stopping) return;
                    stopping = true;
                    void controller.stop().then(() => process.exit(0));
                });
        })
        .catch(() => {
            console.error('Acceptance controller startup failed');
            process.exit(1);
        });
