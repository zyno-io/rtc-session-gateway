import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';

import WebSocket from 'ws';

import { CallRegistry } from '../src/call-registry';
import { ControlConnectionUnavailableError, ControlHub } from '../src/control-hub';
import { ControlServer } from '../src/control-server';
import { loadConfig } from '../src/config';
import { createHttpApp, GatewayController } from '../src/http-server';
import { GatewayMediaController } from '../src/media-controller';
import { SessionCommandHandler } from '../src/session-commands';

test('control websocket registers routes and supports gateway-initiated requests', async () => {
    const registry = new CallRegistry();
    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const hub = new ControlHub(1_000);
    const server = http.createServer(createHttpApp(registry, gateway));
    new ControlServer(
        server,
        { CONTROL_WS_PATH: '/control' },
        hub,
        new SessionCommandHandler(registry, gateway)
    );
    await listen(server);

    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const messages: any[] = [];
    ws.on('message', data => {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.type === 'request' && message.method === 'sip.invite') {
            ws.send(JSON.stringify({
                type: 'response',
                id: message.id,
                ok: true,
                result: { action: 'reject', status: 486, reason: 'Busy Here' }
            }));
        }
    });

    try {
        await once(ws, 'open');
        await waitFor(() => messages.some(message => message.event === 'control.connected'));

        ws.send(JSON.stringify({
            type: 'request',
            id: 'register-1',
            method: 'route.register',
            params: { routes: [{ match: 'exact', value: 'support' }] }
        }));
        await waitFor(() => messages.some(message => message.type === 'response' && message.id === 'register-1'));

        const route = hub.findRoute({ destinationUri: 'sip:support@example.net', destinationUser: 'support' });
        assert.equal(route?.route.value, 'support');

        const response = await hub.request(route!.connectionId, 'sip.invite', { callId: 'call-1' });
        assert.deepEqual(response, { action: 'reject', status: 486, reason: 'Busy Here' });
    } finally {
        ws.close();
        server.close();
    }
});

test('control websocket rejects missing bearer token when configured', async () => {
    const registry = new CallRegistry();
    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const hub = new ControlHub(1_000);
    const server = http.createServer(createHttpApp(registry, gateway));
    new ControlServer(
        server,
        { CONTROL_WS_PATH: '/control', CONTROL_AUTH_TOKEN: 'secret' },
        hub,
        new SessionCommandHandler(registry, gateway)
    );
    await listen(server);

    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    try {
        const [err] = await once(ws, 'error');
        assert.match(String((err as Error).message), /401/);
    } finally {
        server.close();
    }
});

test('gateway-initiated response must come from the requested control connection', async () => {
    const { server, hub } = await startControlServer();
    const wsA = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const wsB = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const messagesA: any[] = [];
    const messagesB: any[] = [];
    wsA.on('message', data => messagesA.push(JSON.parse(data.toString())));
    wsB.on('message', data => messagesB.push(JSON.parse(data.toString())));

    try {
        await Promise.all([once(wsA, 'open'), once(wsB, 'open')]);
        const connectionIdA = (await waitForMessage(messagesA, message => message.event === 'control.connected')).data.connectionId;
        await waitForMessage(messagesB, message => message.event === 'control.connected');

        const pending = hub.request(connectionIdA, 'sip.reinvite', { sessionId: 'call-1' }, 1_000);
        const request = await waitForMessage(messagesA, message => message.type === 'request' && message.method === 'sip.reinvite');

        wsB.send(JSON.stringify({
            type: 'response',
            id: request.id,
            ok: true,
            result: { sdp: 'wrong-sdp' }
        }));

        const early = await Promise.race([
            pending.then(() => 'resolved'),
            delay(50).then(() => 'pending')
        ]);
        assert.equal(early, 'pending');

        wsA.send(JSON.stringify({
            type: 'response',
            id: request.id,
            ok: true,
            result: { sdp: 'right-sdp' }
        }));
        assert.deepEqual(await pending, { sdp: 'right-sdp' });
    } finally {
        wsA.close();
        wsB.close();
        server.close();
    }
});

test('pending gateway-initiated request is rejected when its control connection closes', async () => {
    const { server, hub } = await startControlServer();
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));

    try {
        await once(ws, 'open');
        const connectionId = (await waitForMessage(messages, message => message.event === 'control.connected')).data.connectionId;
        const pending = hub.request(connectionId, 'sip.invite', { callId: 'call-1' }, 10_000);
        await waitForMessage(messages, message => message.type === 'request' && message.method === 'sip.invite');
        ws.close();

        await assert.rejects(
            pending,
            (err: unknown) => err instanceof ControlConnectionUnavailableError
        );
    } finally {
        server.close();
    }
});

test('duplicate route registration is rejected deterministically', async () => {
    const { server } = await startControlServer();
    const wsA = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const wsB = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const messagesA: any[] = [];
    const messagesB: any[] = [];
    wsA.on('message', data => messagesA.push(JSON.parse(data.toString())));
    wsB.on('message', data => messagesB.push(JSON.parse(data.toString())));

    try {
        await Promise.all([once(wsA, 'open'), once(wsB, 'open')]);
        await waitForMessage(messagesA, message => message.event === 'control.connected');
        await waitForMessage(messagesB, message => message.event === 'control.connected');

        wsA.send(JSON.stringify({
            type: 'request',
            id: 'register-a',
            method: 'route.register',
            params: { routes: [{ match: 'exact', value: 'support' }] }
        }));
        const accepted = await waitForMessage(messagesA, message => message.id === 'register-a');
        assert.equal(accepted.ok, true);

        wsB.send(JSON.stringify({
            type: 'request',
            id: 'register-b',
            method: 'route.register',
            params: { routes: [{ match: 'exact', value: 'support' }] }
        }));
        const rejected = await waitForMessage(messagesB, message => message.id === 'register-b');
        assert.equal(rejected.ok, false);
        assert.equal(rejected.error.code, 'ROUTE_CONFLICT');
    } finally {
        wsA.close();
        wsB.close();
        server.close();
    }
});

test('websocket session commands preserve not-found error parity', async () => {
    const { server } = await startControlServer();
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));

    try {
        await once(ws, 'open');
        await waitForMessage(messages, message => message.event === 'control.connected');
        ws.send(JSON.stringify({
            type: 'request',
            id: 'get-missing',
            method: 'session.get',
            params: { sessionId: 'missing' }
        }));
        const response = await waitForMessage(messages, message => message.id === 'get-missing');
        assert.equal(response.ok, false);
        assert.equal(response.error.code, 'NOT_FOUND');
    } finally {
        ws.close();
        server.close();
    }
});

test('websocket-created media sessions receive the owner control connection id', async () => {
    const registry = new CallRegistry();
    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const media = new FakeMediaController();
    const hub = new ControlHub(1_000);
    const server = http.createServer(createHttpApp(registry, gateway, media));
    new ControlServer(
        server,
        { CONTROL_WS_PATH: '/control' },
        hub,
        new SessionCommandHandler(registry, gateway, media)
    );
    await listen(server);

    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/control`);
    const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));

    try {
        await once(ws, 'open');
        const connected = await waitForMessage(messages, message => message.event === 'control.connected');
        ws.send(JSON.stringify({
            type: 'request',
            id: 'create-session',
            method: 'session.create',
            params: { callId: 'call-1' }
        }));
        const response = await waitForMessage(messages, message => message.id === 'create-session');
        assert.equal(response.ok, true);
        assert.deepEqual(media.createSessionCalls, [{ callId: 'call-1', ownerConnectionId: connected.data.connectionId }]);
    } finally {
        ws.close();
        server.close();
    }
});

test('production config requires control auth unless explicitly disabled', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), /CONTROL_AUTH_TOKEN/);
    const config = loadConfig({ NODE_ENV: 'production', CONTROL_AUTH_MODE: 'none' } as NodeJS.ProcessEnv);
    assert.equal(config.CONTROL_AUTH_MODE, 'none');
});

test('Drachtio application routing configuration is validated', () => {
    assert.throws(() => loadConfig({ DRACHTIO_APP_TAG: 'invalid tag' } as NodeJS.ProcessEnv), /DRACHTIO_APP_TAG/);
    assert.throws(() => loadConfig({ DRACHTIO_ROUTE_FALLBACK_URL: 'not a url' } as NodeJS.ProcessEnv), /DRACHTIO_ROUTE_FALLBACK_URL/);

    const config = loadConfig({
        DRACHTIO_APP_TAG: 'rtc-session-gateway',
        DRACHTIO_ROUTE_FALLBACK_URL: 'http://zynotalk-pilot-server:3000/drachtio/route'
    } as NodeJS.ProcessEnv);
    assert.equal(config.DRACHTIO_APP_TAG, 'rtc-session-gateway');
    assert.equal(config.DRACHTIO_ROUTE_FALLBACK_URL, 'http://zynotalk-pilot-server:3000/drachtio/route');
});

test('coturn credential configuration defaults to an all-day lifetime and validates overrides', () => {
    assert.equal(loadConfig({} as NodeJS.ProcessEnv).COTURN_CREDENTIAL_TTL_SECONDS, 86_400);
    const config = loadConfig({ COTURN_AUTH_SECRET: 'turn-secret', COTURN_CREDENTIAL_TTL_SECONDS: '43200' } as NodeJS.ProcessEnv);
    assert.equal(config.COTURN_AUTH_SECRET, 'turn-secret');
    assert.equal(config.COTURN_CREDENTIAL_TTL_SECONDS, 43_200);
    assert.throws(() => loadConfig({ COTURN_CREDENTIAL_TTL_SECONDS: '0' } as NodeJS.ProcessEnv), /positive integer/);
});

async function listen(server: http.Server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
}

async function startControlServer() {
    const registry = new CallRegistry();
    const gateway: GatewayController = {
        isConnected: true,
        reinvite: async () => ({ sdp: 'remote-sdp' }),
        bye: async () => { }
    };
    const hub = new ControlHub(1_000);
    const server = http.createServer(createHttpApp(registry, gateway));
    new ControlServer(
        server,
        { CONTROL_WS_PATH: '/control' },
        hub,
        new SessionCommandHandler(registry, gateway)
    );
    await listen(server);
    return { server, hub };
}

async function waitFor(predicate: () => boolean) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > 1_000) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function waitForMessage<T>(messages: T[], predicate: (message: T) => boolean): Promise<T> {
    const start = Date.now();
    while (true) {
        const message = messages.find(predicate);
        if (message) return message;
        if (Date.now() - start > 1_000) throw new Error('Timed out waiting for message');
        await delay(10);
    }
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class FakeMediaController implements GatewayMediaController {
    createSessionCalls: unknown[] = [];

    list = () => [];
    get = () => undefined;
    async createSession(params?: { callId?: string; ownerConnectionId?: string }) {
        this.createSessionCalls.push(params);
        return {
            sessionId: 'media-session-1',
            callId: params?.callId,
            backendId: 'rtpbridge-0',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            endpoints: []
        };
    }
    async destroySession() {}
    async createWebrtcOffer() { return { endpointId: 'webrtc-1', sdpOffer: 'offer-sdp' }; }
    async createWebrtcFromOffer() { return { endpointId: 'webrtc-1', sdpAnswer: 'answer-sdp' }; }
    async acceptWebrtcAnswer() { return { ok: true as const }; }
    async acceptWebrtcOffer() { return { sdpAnswer: 'answer-sdp' }; }
    async restartIce() { return { sdpOffer: 'offer-sdp', offerGeneration: 1 }; }
    async createRtpOffer() { return { endpointId: 'rtp-1', sdpOffer: 'offer-sdp' }; }
    async createRtpFromOffer() { return { endpointId: 'rtp-1', sdpAnswer: 'answer-sdp' }; }
    async acceptRtpAnswer() { return { ok: true as const }; }
    async rtpReinvite() { return { sdpAnswer: 'answer-sdp' }; }
    async play() { return { endpointId: 'file-1' }; }
    async stopMedia() { return { ok: true as const }; }
    async updateDirection() { return { ok: true as const }; }
    async bridge() {
        return {
            sessionId: 'media-session-1',
            endpointId: 'bridge-1',
            targetSessionId: 'media-session-2',
            targetEndpointId: 'bridge-2'
        };
    }
    async unbridge() { return { ok: true as const }; }
    async gather() { return { digits: '', reason: 'timeout' as const }; }
    async playAndGather() { return { digits: '', reason: 'timeout' as const, playbackEndpointId: 'file-1' }; }
    async leaveMessage() {
        return {
            terminator: 'silence' as const,
            messagePlayed: true
        };
    }
    async injectDtmf() { return { ok: true as const }; }
    async startRecording() { return { recordingId: 'rec-1' }; }
    async stopRecording() { return { filePath: '/tmp/rec.pcap', durationMs: 0, packets: 0 }; }
    async listRecordings() { return { recordings: [], total: 0, skip: 0, limit: 100 }; }
    async downloadRecording() { return { status: 200, headers: {}, stream: Readable.from([]) }; }
    async mergeRecordings() { return { status: 200, headers: {}, stream: Readable.from([]) }; }
    async deleteRecording() { return { deleted: true as const }; }
}
