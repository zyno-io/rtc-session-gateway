import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import WebSocket from 'ws';

import { CallRegistry } from '../src/call-registry';
import { loadConfig } from '../src/config';
import { ControlHub } from '../src/control-hub';
import { ControlServer } from '../src/control-server';
import { GatewayLifecycle } from '../src/gateway-lifecycle';
import { createHttpApp, GatewayController } from '../src/http-server';
import type { GatewayMediaController } from '../src/media-controller';
import { SessionCommandHandler } from '../src/session-commands';

test('draining waits for admitted asynchronous setup and live resources without resetting its deadline', async () => {
    let resources = 0;
    const stopped: boolean[] = [];
    const lifecycle = new GatewayLifecycle({ maxWaitMs: 2_000, cleanupTimeoutMs: 100, activeResources: () => resources, stop: async forced => { stopped.push(forced); } });
    const setup = Promise.withResolvers<void>();
    const operation = lifecycle.track(async () => { await setup.promise; resources++; });
    const drain = lifecycle.drain('test');
    assert.equal(lifecycle.drain('repeat'), drain);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(stopped, []);
    setup.resolve();
    await operation;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(stopped, []);
    resources = 0;
    await drain;
    assert.deepEqual(stopped, [false]);
});

test('drain deadline forces cleanup and bounds an unresponsive cleanup operation', async () => {
    const stopped: boolean[] = [];
    const lifecycle = new GatewayLifecycle({
        maxWaitMs: 50, cleanupTimeoutMs: 50, activeResources: () => 1,
        stop: forced => { stopped.push(forced); return new Promise(() => {}); }
    });
    const finish = lifecycle.beginOperation();
    const drain = lifecycle.drain('test');
    await drain;
    finish();
    finish();
    assert.deepEqual(stopped, [true]);
    assert.throws(() => lifecycle.beginOperation(), /draining/);
});

test('HTTP and control drain admission keeps existing owners usable and permits media for admitted SIP setup', async () => {
    const registry = new CallRegistry();
    const admittedCallId = registry.reserveCallId('admitted@example.com');
    let resources = 1;
    let creations = 0;
    const lifecycle = new GatewayLifecycle({ maxWaitMs: 5_000, cleanupTimeoutMs: 100, activeResources: () => resources, stop: async () => {} });
    const gateway: GatewayController = {
        isConnected: true,
        createOutbound: async () => { creations++; return { sessionId: 'call', sipCallId: 'call', sdp: 'sdp' }; },
        reinvite: async () => ({ sdp: 'existing-call-answer' }),
        bye: async () => {}
    };
    const media = {
        list: () => [],
        createSession: async () => { creations++; return { sessionId: 'media' }; }
    } as unknown as GatewayMediaController;
    const config = loadConfig({ CONTROL_AUTH_TOKEN: 'test-token', DRACHTIO_APP_TAG: 'test', ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://app.example/sip"}]' });
    const hub = new ControlHub(1_000);
    const server = http.createServer(createHttpApp(registry, gateway, media, config, config, hub, lifecycle));
    const controlServer = new ControlServer(server, config, hub, new SessionCommandHandler(registry, gateway, media, lifecycle), lifecycle);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const wsUrl = `ws://127.0.0.1:${address.port}/control`;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer test-token' } });
    const responses = new Map<string, { ok: boolean; error?: { code: string }; result?: unknown }>();
    ws.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'response') responses.set(message.id, message); });
    const request = async (path: string, body: unknown, token = 'test-token') => {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return response;
    };
    try {
        await once(ws, 'open');
        const ready = await fetch(`${base}/readyz`);
        assert.equal(ready.status, 200);
        const denied = await request('/drain', {}, 'wrong-token');
        assert.equal(denied.status, 401);
        assert.equal(lifecycle.isDraining, false);
        const drain = await request('/drain', {});
        assert.equal(drain.status, 202);
        const notReady = await fetch(`${base}/readyz`);
        const healthy = await fetch(`${base}/healthz`);
        assert.equal(notReady.status, 503);
        assert.equal(healthy.status, 200);
        const blockedSession = await request('/sessions', {});
        const blockedCall = await request('/calls', { requestUri: 'sip:new@example.com', sdp: 'sdp', receiverUrl: 'https://app.example/sip' });
        const blockedRoute = await fetch(`${base}/drachtio/route?uri=sip:support@example.com`);
        const routeBody = await blockedRoute.json();
        assert.equal(blockedSession.status, 503);
        assert.equal(blockedCall.status, 503);
        assert.equal(routeBody.data.status, 503);
        assert.equal(creations, 0);
        const admittedSession = await request('/sessions', { callId: admittedCallId });
        assert.equal(admittedSession.status, 200);
        const existing = await request('/calls/established/reinvite', { sdp: 'sdp' });
        assert.equal(existing.status, 200);
        for (const [id, method, params] of [
            ['new-session', 'session.create', {}], ['new-route', 'route.register', { routes: [] }], ['existing', 'session.list', {}]
        ]) ws.send(JSON.stringify({ type: 'request', id, method, params }));
        await waitFor(() => responses.size === 3);
        assert.equal(responses.get('new-session')?.error?.code, 'SHUTTING_DOWN');
        assert.equal(responses.get('new-route')?.error?.code, 'SHUTTING_DOWN');
        assert.equal(responses.get('existing')?.ok, true);
        assert.equal(ws.readyState, WebSocket.OPEN);
        await new Promise<void>((resolve, reject) => {
            const blocked = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer test-token' } });
            blocked.on('error', () => {});
            blocked.on('unexpected-response', (_req, response) => {
                response.resume(); blocked.terminate();
                if (response.statusCode === 503) resolve(); else reject(new Error(`Unexpected status ${response.statusCode}`));
            });
            blocked.on('open', () => { blocked.terminate(); reject(new Error('Upgrade accepted during drain')); });
        });
    } finally {
        ws.terminate();
        controlServer.close();
        server.close();
        resources = 0;
        await lifecycle.drain('cleanup');
    }
});

test('shutdown timeout configuration requires positive integers', () => {
    assert.equal(loadConfig({}).SHUTDOWN_MAX_WAIT_MS, 1_800_000);
    for (const key of ['SHUTDOWN_MAX_WAIT_MS', 'SHUTDOWN_CLEANUP_TIMEOUT_MS']) {
        for (const value of ['0', '-1', '1.5', 'invalid']) assert.throws(() => loadConfig({ [key]: value }), /positive integer/);
    }
});

async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for control responses');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
