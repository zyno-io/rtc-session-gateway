import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CallRegistry } from '../src/call-registry';
import { loadConfig } from '../src/config';
import { SipGateway } from '../src/sip-gateway';
import type { SipbridgeSignaling, NativeDialog, SipResponse } from '../src/sipbridge-signaling';
import type { GatewayHttpClient } from '../src/http-client';
import { ControlHub } from '../src/control-hub';
import { GatewayLifecycle } from '../src/gateway-lifecycle';
import { loadFirewallConfig, SipFirewall } from '../src/sip-firewall';

class Dialog extends EventEmitter {
    sipCallId = 'outbound@example.com';
    localSdp = 'offer';
    remoteSdp = 'answer';
    byes = 0;
    activate() {}
    async bye() {
        this.byes++;
    }
    async reinvite(sdp: string) {
        return 'remote-' + sdp;
    }
}
function response(dialog = new Dialog()) {
    const record: {
        status?: number;
        sdp?: string;
        finalResponseSent: boolean;
        respond: SipResponse['respond'];
        answer: SipResponse['answer'];
    } = {
        finalResponseSent: false,
        async respond(status) {
            record.status = status;
            record.finalResponseSent = status >= 200;
        },
        async answer(sdp) {
            record.sdp = sdp;
            record.finalResponseSent = true;
            return dialog as unknown as NativeDialog;
        }
    };
    return record;
}
function invite(uri = 'sip:support@example.net') {
    const headers: Record<string, string> = {
        'call-id': 'abc@example.com',
        from: '<sip:caller@example.net>',
        to: '<sip:support@example.net>'
    };
    return {
        method: 'INVITE',
        uri,
        callId: 'abc@example.com',
        body: 'offer',
        headers,
        get: (name: string) => headers[name.toLowerCase()]
    };
}
function http(actions: unknown[], calls: unknown[] = []): GatewayHttpClient {
    return {
        async postJson<T>(_url: string, body: unknown): Promise<T> {
            calls.push(body);
            return actions.shift() as T;
        }
    };
}
const config = () =>
    loadConfig({
        ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]'
    });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('inbound policy rejects unknown routes and foreign domains before calling owners', async () => {
    const cfg = config();
    cfg.SIP_ALLOWED_DOMAINS = ['sg.example.net'];
    const calls: unknown[] = [];
    const gateway = new SipGateway(cfg, new CallRegistry(), http([], calls));
    const res = response();
    await gateway.handleInvite(invite(), res);
    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
});
test('HTTP owner answers before call activation and gets follow-up events without native references', async () => {
    const registry = new CallRegistry();
    const calls: unknown[] = [];
    const dialog = new Dialog();
    const gateway = new SipGateway(config(), registry, http([{ action: 'answer', sdp: 'local-answer' }, {}], calls));
    const res = response(dialog);
    await gateway.handleInvite(invite(), res);
    await tick();
    assert.equal(res.sdp, 'local-answer');
    assert.equal(registry.size, 1);
    assert.equal((calls[0] as { event: string }).event, 'invite');
    assert.equal((calls[1] as { event: string }).event, 'answered');
    assert.equal('dialog' in registry.list()[0], false);
    dialog.emit('ended', 'bye');
    await tick();
    assert.equal(registry.size, 0);
    assert.equal((calls[2] as { event: string }).event, 'bye');
});
test('pre-media owner rejection releases the call reservation', async () => {
    const registry = new CallRegistry();
    const gateway = new SipGateway(config(), registry, http([{ action: 'reject', status: 486 }]));
    const res = response();
    await gateway.handleInvite(invite(), res);
    assert.equal(res.status, 486);
    assert.equal(registry.pendingCount, 0);
    assert.equal(registry.size, 0);
});
test('failed activation destroys the answered native dialog and reports termination', async () => {
    const registry = new CallRegistry();
    registry.activate = () => {
        throw new Error('failed activation');
    };
    const events: unknown[] = [];
    const dialog = new Dialog();
    const gateway = new SipGateway(config(), registry, http([{ action: 'answer', sdp: 'sdp' }, {}], events));
    await gateway.handleInvite(invite(), response(dialog));
    await tick();
    assert.equal(dialog.byes, 1);
    assert.equal(registry.pendingCount, 0);
    assert.equal((events[1] as { event: string }).event, 'terminated');
});
test('control owner pre-media requests avoid HTTP and preserve owner affinity', async () => {
    const hub = new ControlHub(1000);
    const sent: string[] = [];
    const socket = {
        on() {
            return socket;
        },
        readyState: 1,
        send(text: string, callback?: (error?: Error) => void) {
            sent.push(text);
            const request = JSON.parse(text);
            if (request.type === 'request')
                queueMicrotask(() =>
                    hub.handleResponse(id, {
                        type: 'response',
                        id: request.id,
                        ok: true,
                        result: { action: 'answer', sdp: 'control-answer' }
                    })
                );
            callback?.();
        }
    };
    const id = hub.registerConnection(socket as never);
    hub.setRoutes(id, [{ match: 'exact', value: 'support' }]);
    const registry = new CallRegistry();
    const calls: unknown[] = [];
    const gateway = new SipGateway(config(), registry, http([], calls), undefined, hub);
    await gateway.handleInvite(invite(), response());
    await tick();
    assert.equal(registry.list()[0].controlConnectionId, id);
    assert.equal(calls.length, 0);
    assert.ok(sent.some(text => text.includes('sip.answered')));
    hub.unregisterConnection(id);
});
test('native outbound parameters and cancellation remain bound to the initiating control owner', async () => {
    let reject!: (error: Error) => void;
    let cancellations = 0;
    const driver = {
        openDialog() {
            return {
                completed: new Promise<NativeDialog>((_resolve, fail) => {
                    reject = fail;
                }),
                async cancel() {
                    cancellations++;
                    reject(new Error('cancelled'));
                }
            };
        }
    } as unknown as SipbridgeSignaling;
    const gateway = new SipGateway(config(), new CallRegistry(), http([]), driver);
    const attempt = gateway.createOutbound({
        requestUri: 'sip:target@example.net',
        sdp: 'offer',
        controlConnectionId: 'owner-a',
        outboundAttemptId: 'attempt'
    });
    const failed = assert.rejects(attempt, /cancel/);
    await assert.rejects(gateway.cancelOutbound('attempt', 'owner-b'), /another control connection/);
    await gateway.cancelOutbound('attempt', 'owner-a');
    await failed;
    // The app's cancel plus the failure-path CANCEL: a second CANCEL on a finished attempt is harmless and covers a refused first one.
    assert.equal(cancellations, 2);
});
test('drain rejects new SIP admission while preserving retained dialog commands', async () => {
    const registry = new CallRegistry();
    const lifecycle = new GatewayLifecycle({
        maxWaitMs: 2000,
        cleanupTimeoutMs: 100,
        activeResources: () => registry.size,
        stop: async () => {}
    });
    const dialog = new Dialog();
    const gateway = new SipGateway(config(), registry, http([{ action: 'answer', sdp: 'sdp' }, {}, {}]), undefined, undefined, lifecycle);
    await gateway.handleInvite(invite(), response(dialog));
    const draining = lifecycle.drain('test');
    const rejected = response();
    await gateway.handleInvite(invite(), rejected);
    assert.equal(rejected.status, 503);
    await assert.rejects(
        gateway.createOutbound({
            requestUri: 'sip:new@example.net',
            sdp: 'sdp',
            receiverUrl: 'https://owner.test'
        }),
        /draining/
    );
    assert.deepEqual(await gateway.reinvite('abc@example.com', 'new-sdp'), { sdp: 'remote-new-sdp' });
    await gateway.bye('abc@example.com');
    await draining;
    assert.equal(dialog.byes, 1);
});

test('firewall route misses are not scored without connected owners or shortly after an owner disconnects', () => {
    const message = (uri: string) => ({ method: 'INVITE', uri, headers: [] }) as never;
    const source = { ip: '192.0.2.7', port: 5060, transport: 'udp' };
    const setup = (routes: string, mode = 'enforce') => {
        const firewall = new SipFirewall(
            loadFirewallConfig({ SIP_FIREWALL_MODE: mode, SIP_FIREWALL_THRESHOLD: '100', SIP_FIREWALL_ROUTE_GRACE_MS: '1000' })
        );
        const hub = new ControlHub(1000);
        const signaling = new EventEmitter() as unknown as SipbridgeSignaling;
        const gateway = new SipGateway(
            loadConfig({ ROUTES_JSON: routes, SIP_ALLOWED_DOMAINS_JSON: '["localhost"]' }),
            new CallRegistry(),
            http([]),
            signaling,
            hub,
            undefined,
            { firewall }
        );
        const admit = (uri = 'sip:nobody@localhost') =>
            (gateway as unknown as { admitRoute(m: never, s: typeof source): number | undefined }).admitRoute(message(uri), source);
        return { firewall, hub, gateway, admit, signaling: signaling as unknown as { routePolicy?: unknown } };
    };
    const socket = () => Object.assign(new EventEmitter(), { close() {}, send() {} }) as never;
    // Control routing with no owner connected: 404, unscored.
    let t = setup('[]');
    assert.equal(t.admit(), 404);
    assert.equal(t.firewall.counters.observations, 0);
    // An outbound-only connection (no routes) is not an owner: still unscored.
    const outbound = t.hub.registerConnection(socket());
    assert.equal(t.admit(), 404);
    assert.equal(t.firewall.counters.observations, 0);
    // Owner connected and settled: scored.
    const id = t.hub.registerConnection(socket());
    t.hub.setRoutes(id, [{ match: 'exact', value: 'support' }]);
    assert.equal(t.admit(), 404);
    assert.equal(t.firewall.counters.observations, 1);
    // Owner disconnects while the outbound-only connection stays: unscored (no owner, then within grace).
    t.hub.unregisterConnection(id);
    assert.equal(t.hub.size, 1);
    assert.equal(t.admit(), 404);
    assert.equal(t.firewall.counters.observations, 1);
    // A returning owner is unscored within the grace window.
    const again = t.hub.registerConnection(socket());
    t.hub.setRoutes(again, [{ match: 'exact', value: 'support' }]);
    assert.equal(t.admit(), 404);
    assert.equal(t.firewall.counters.observations, 1);
    t.hub.unregisterConnection(outbound);
    // Unknown host is always scored.
    t = setup('[]');
    assert.equal(t.admit('sip:x@evil.example'), 404);
    assert.equal(t.firewall.counters.observations, 1);
    // Static routes only: scored without owners.
    t = setup('[{"match":"exact","value":"support","url":"https://owner.test/sip"}]');
    assert.equal(t.admit(), 404);
    assert.equal(t.firewall.counters.observations, 1);
    // Mode off installs no admission-time route check.
    t = setup('[]', 'off');
    assert.equal(t.signaling.routePolicy, undefined);
});
