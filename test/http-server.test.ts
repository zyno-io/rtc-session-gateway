import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { CallRegistry } from '../src/call-registry';
import { createHttpApp, GatewayController } from '../src/http-server';

test('HTTP control API returns health and active call detail', async () => {
    const registry = new CallRegistry();
    const callId = registry.reserveCallId('abc@example.com');
    registry.activate({
        callId,
        sipCallId: 'abc@example.com',
        routeUrl: 'https://example.com/sip',
        receiverUrl: 'https://example.com/calls/abc',
        destinationUri: 'sip:support@example.net',
        destinationUser: 'support',
        createdAt: '2026-06-29T00:00:00.000Z',
        updatedAt: '2026-06-29T00:00:00.000Z',
        dialog: {} as any
    });

    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const server = await listen(createHttpApp(registry, gateway));
    try {
        const health = await requestJson(server, '/healthz');
        assert.deepEqual(health, { ok: true, calls: 1 });

        const detail = await requestJson(server, `/calls/${callId}`);
        assert.equal(detail.callId, callId);
        assert.equal(detail.dialog, undefined);
    } finally {
        server.close();
    }
});

test('HTTP re-INVITE validates body and calls controller', async () => {
    let reinviteBody: { callId: string; sdp: string; headers?: Record<string, string> } | undefined;
    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async (callId, sdp, headers) => {
            reinviteBody = { callId, sdp, headers };
            return { sdp: 'remote-sdp' };
        },
        bye: async () => { }
    };

    const server = await listen(createHttpApp(new CallRegistry(), gateway));
    try {
        const bad = await requestJson(server, '/calls/call-1/reinvite', { method: 'POST', body: {} });
        assert.equal(bad.status, 400);

        const ok = await requestJson(server, '/calls/call-1/reinvite', {
            method: 'POST',
            body: { sdp: 'local-sdp', headers: { Contact: '<sip:gw@example.net>' } }
        });
        assert.deepEqual(ok, { sdp: 'remote-sdp' });
        assert.deepEqual(reinviteBody, {
            callId: 'call-1',
            sdp: 'local-sdp',
            headers: { Contact: '<sip:gw@example.net>' }
        });
    } finally {
        server.close();
    }
});

async function listen(app: ReturnType<typeof createHttpApp>) {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
}

async function requestJson(server: http.Server, path: string, init?: { method?: string; body?: unknown }) {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not listen on TCP');

    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: init?.method,
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined
    });
    const body = await response.json();
    return response.ok ? body : { status: response.status, ...body };
}
