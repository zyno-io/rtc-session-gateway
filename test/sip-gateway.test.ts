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
    assert.equal(cancellations, 1);
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
