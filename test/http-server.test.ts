import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import type { Express } from 'express';

import { CallRegistry } from '../src/call-registry';
import { ControlHub } from '../src/control-hub';
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

test('Drachtio router selects the gateway tag only for owned routes without bearer auth', async () => {
    const controlHub = new ControlHub(1_000);
    const controlSocket = { on: () => controlSocket, readyState: 1, send: () => undefined } as any;
    const connectionId = controlHub.registerConnection(controlSocket);
    controlHub.setRoutes(connectionId, [{ match: 'exact', value: 'c2c-dev' }]);
    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const server = await listen(createHttpApp(
        new CallRegistry(),
        gateway,
        undefined,
        { CONTROL_AUTH_MODE: 'bearer', CONTROL_AUTH_TOKEN: 'secret-token' },
        {
            DRACHTIO_APP_TAG: 'rtc-session-gateway',
            DRACHTIO_ROUTE_FALLBACK_URL: undefined,
            INVITE_HTTP_TIMEOUT_MS: 1_000,
            ROUTES: []
        },
        controlHub
    ));
    try {
        const selected = await requestJson(server, '/drachtio/route?uri=sip%3Ac2c-dev%40sg.sip.zynotalk.dev&uriUser=c2c-dev');
        assert.deepEqual(selected, {
            action: 'route',
            data: { tag: 'rtc-session-gateway' }
        });

        const rejected = await requestJson(server, '/drachtio/route?uri=sip%3Aother%40sg.sip.zynotalk.dev&uriUser=other');
        assert.deepEqual(rejected, {
            action: 'reject',
            data: { status: 404, reason: 'No Route' }
        });
    } finally {
        server.close();
    }
});

test('Drachtio router preserves the existing fallback for unowned routes', async () => {
    let receivedUrl: string | undefined;
    const fallback = http.createServer((req, res) => {
        receivedUrl = req.url;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ action: 'route', data: { uri: 'zynotalk-nexus-server:39806' } }));
    });
    fallback.listen(0, '127.0.0.1');
    await once(fallback, 'listening');
    const fallbackAddress = fallback.address();
    if (!fallbackAddress || typeof fallbackAddress === 'string') throw new Error('Fallback did not listen on TCP');

    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const server = await listen(createHttpApp(
        new CallRegistry(),
        gateway,
        undefined,
        undefined,
        {
            DRACHTIO_APP_TAG: 'rtc-session-gateway',
            DRACHTIO_ROUTE_FALLBACK_URL: `http://127.0.0.1:${fallbackAddress.port}/drachtio/route`,
            INVITE_HTTP_TIMEOUT_MS: 1_000,
            ROUTES: []
        }
    ));
    try {
        const response = await requestJson(server, '/drachtio/route?uri=sip%3Aother%40sg.sip.zynotalk.dev&uriUser=other');
        assert.deepEqual(response, { action: 'route', data: { uri: 'zynotalk-nexus-server:39806' } });
        assert.match(receivedUrl ?? '', /^\/drachtio\/route\?/);
        assert.match(receivedUrl ?? '', /uriUser=other/);
    } finally {
        server.close();
        fallback.close();
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

async function listen(app: Express) {
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
