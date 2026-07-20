import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CallRegistry } from '../src/call-registry';
import { ControlRouteMatch } from '../src/control-hub';
import type { GatewayConfig } from '../src/config';
import { DrachtioGateway } from '../src/drachtio-gateway';
import { GatewayHttpClient } from '../src/http-client';

interface FakeSrfConnectOptions {
    reconnect?: {
        retryMaxDelay: number;
    };
}

test('backs off before starting drachtio-srf when the endpoint is unavailable', async () => {
    const srf = new FakeSrf();
    const attempts: number[] = [];
    const retryDelays: number[] = [];
    const gateway = new DrachtioGateway(config([]), new CallRegistry(), new FakeHttpClient([]), srf as any, undefined, {
        endpointProbe: async endpoint => {
            attempts.push(endpoint.timeoutMs);
            if (attempts.length < 4) throw new Error('not ready');
        },
        retryDelay: async delayMs => {
            retryDelays.push(delayMs);
        },
        initialRetryDelayMs: 100,
        maxRetryDelayMs: 250,
        endpointTimeoutMs: 50
    });

    await gateway.start();

    assert.deepEqual(attempts, [50, 50, 50, 50]);
    assert.deepEqual(retryDelays, [100, 200, 250]);
    assert.equal(srf.connectCalls, 1);
    assert.deepEqual(srf.connectOptions?.reconnect, { retryMaxDelay: 250 });
});

test('unmatched INVITE receives 404', async () => {
    const registry = new CallRegistry();
    const gateway = new DrachtioGateway(config([]), registry, new FakeHttpClient([]), new FakeSrf() as any);
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);

    assert.deepEqual(res.sent, { status: 404, reason: 'No Route', opts: {} });
    assert.equal(registry.size, 0);
});

test('answered INVITE creates a call and sends answered event to receiver URL', async () => {
    const registry = new CallRegistry();
    const httpClient = new FakeHttpClient([
        {
            action: 'answer',
            sdp: 'local-sdp',
            receiverUrl: 'https://receiver.example.com/call'
        },
        { ok: true }
    ]);
    const srf = new FakeSrf();
    const gateway = new DrachtioGateway(config([{ match: 'exact', value: 'support', url: 'https://route.example.com/sip' }]), registry, httpClient, srf as any);
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);
    await new Promise(resolve => setImmediate(resolve));

    const calls = registry.list();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].callId, 'abc@example.com');
    assert.equal(calls[0].receiverUrl, 'https://receiver.example.com/call');
    assert.equal(srf.createdUas?.opts.localSdp, 'local-sdp');
    assert.equal(httpClient.posts[0].url, 'https://route.example.com/sip');
    assert.equal(httpClient.posts[1].url, 'https://receiver.example.com/call');
    assert.equal((httpClient.posts[1].body as any).event, 'answered');
});

test('control route answers INVITE without HTTP route callback', async () => {
    const registry = new CallRegistry();
    const httpClient = new FakeHttpClient([]);
    const srf = new FakeSrf();
    const controlHub = new FakeControlHub({ action: 'answer', sdp: 'control-local-sdp' });
    const gateway = new DrachtioGateway(
        config([{ match: 'exact', value: 'support', url: 'https://route.example.com/sip' }]),
        registry,
        httpClient,
        srf as any,
        controlHub as any
    );
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(httpClient.posts.length, 0);
    assert.equal(controlHub.requests.length, 1);
    assert.equal(controlHub.requests[0].method, 'sip.invite');
    assert.equal((controlHub.requests[0].params as any).sdp, 'remote-sdp');
    assert.equal(srf.createdUas?.opts.localSdp, 'control-local-sdp');
    assert.equal(registry.list()[0].controlConnectionId, 'conn-1');
});

test('control-only route answers INVITE without static HTTP route', async () => {
    const registry = new CallRegistry();
    const httpClient = new FakeHttpClient([]);
    const srf = new FakeSrf();
    const controlHub = new FakeControlHub({ action: 'answer', sdp: 'control-local-sdp' });
    const gateway = new DrachtioGateway(config([]), registry, httpClient, srf as any, controlHub as any);
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);
    await new Promise(resolve => setImmediate(resolve));

    const calls = registry.list();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].routeUrl, 'control://conn-1');
    assert.equal(calls[0].receiverUrl, 'control://conn-1');
    assert.equal(httpClient.posts.length, 0);
    assert.equal(controlHub.requests[0].method, 'sip.invite');
    assert.equal(srf.createdUas?.opts.localSdp, 'control-local-sdp');
});

test('control route receives a termination event when SIP answer setup fails', async () => {
    const registry = new CallRegistry();
    const srf = new FakeSrf();
    srf.createUasError = new Error('createUAS failed');
    const controlHub = new FakeControlHub({ action: 'answer', sdp: 'control-local-sdp' });
    const gateway = new DrachtioGateway(config([]), registry, new FakeHttpClient([]), srf as any, controlHub as any);
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(registry.size, 0);
    assert.deepEqual(res.sent, { status: 502, reason: 'Bad Gateway', opts: {} });
    assert.equal(controlHub.events.length, 1);
    assert.equal(controlHub.events[0].event.event, 'sip.terminated');
    assert.equal(controlHub.events[0].event.sessionId, 'abc@example.com');
    assert.equal((controlHub.events[0].event.data as any).reason, 'answer-failed');
});

test('answered SIP dialog is destroyed when call registration fails', async () => {
    const registry = new CallRegistry();
    registry.activate = () => {
        throw new Error('registration failed');
    };
    const srf = new FakeSrf();
    const controlHub = new FakeControlHub({ action: 'answer', sdp: 'control-local-sdp' });
    const gateway = new DrachtioGateway(config([]), registry, new FakeHttpClient([]), srf as any, controlHub as any);
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(registry.size, 0);
    assert.equal(srf.destroyedDialogs, 1);
    assert.equal(controlHub.events.length, 1);
    assert.equal(controlHub.events[0].event.event, 'sip.terminated');
    assert.equal((controlHub.events[0].event.data as any).reason, 'answer-failed');
});

test('control route can reject INVITE before HTTP or dialog creation', async () => {
    const registry = new CallRegistry();
    const httpClient = new FakeHttpClient([]);
    const srf = new FakeSrf();
    const controlHub = new FakeControlHub({ action: 'reject', status: 486, reason: 'Busy Here' });
    const gateway = new DrachtioGateway(
        config([{ match: 'exact', value: 'support', url: 'https://route.example.com/sip' }]),
        registry,
        httpClient,
        srf as any,
        controlHub as any
    );
    const res = new FakeResponse();

    await gateway.handleInvite(fakeInvite(), res as any);

    assert.deepEqual(res.sent, { status: 486, reason: 'Busy Here', opts: { headers: undefined } });
    assert.equal(httpClient.posts.length, 0);
    assert.equal(srf.createdUas, undefined);
    assert.equal(registry.size, 0);
});

test('createOutbound creates a UAC dialog and registers it as an active call', async () => {
    const registry = new CallRegistry();
    const httpClient = new FakeHttpClient([]);
    const srf = new FakeSrf();
    const gateway = new DrachtioGateway(config([]), registry, httpClient, srf as any);

    const result = await gateway.createOutbound({
        requestUri: 'sip:15551234567@carrier.example.com',
        sdp: 'local-offer-sdp',
        controlConnectionId: 'conn-1',
        callingNumber: '18005551212',
        callingName: 'ACME SUPPORT',
        headers: { 'X-Test': 'yes' },
        auth: { username: 'carrier-user', password: 'carrier-password' }
    });

    assert.deepEqual(result, {
        sessionId: 'outbound@example.com',
        sipCallId: 'outbound@example.com',
        sdp: 'remote-answer-sdp'
    });
    assert.equal(srf.createdUac?.uri, 'sip:15551234567@carrier.example.com');
    assert.equal((srf.createdUac?.opts as any).localSdp, 'local-offer-sdp');
    assert.equal((srf.createdUac?.opts as any).callingNumber, '18005551212');
    assert.equal((srf.createdUac?.opts as any).headers['X-Test'], 'yes');
    assert.deepEqual((srf.createdUac?.opts as any).auth, {
        username: 'carrier-user',
        password: 'carrier-password'
    });
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0].receiverUrl, 'control://conn-1');
    assert.equal(registry.list()[0].remoteSdp, 'remote-answer-sdp');
});

test('cancelOutbound sends CANCEL for a pending UAC attempt', async () => {
    const srf = new PendingFakeSrf();
    const gateway = new DrachtioGateway(config([]), new CallRegistry(), new FakeHttpClient([]), srf as any);
    const creation = gateway.createOutbound({
        requestUri: 'sip:15551234567@carrier.example.com',
        sdp: 'local-offer-sdp',
        controlConnectionId: 'conn-1',
        outboundAttemptId: 'attempt-1'
    });

    await new Promise(resolve => setImmediate(resolve));
    await gateway.cancelOutbound('attempt-1', 'conn-1');
    assert.equal(srf.cancelCalls, 1);

    srf.rejectUac(new Error('Sip non-success response: 487'));
    await assert.rejects(creation, /487/);
});

test('cancelOutbound rejects cancellation from another control connection', async () => {
    const srf = new PendingFakeSrf();
    const gateway = new DrachtioGateway(config([]), new CallRegistry(), new FakeHttpClient([]), srf as any);
    const creation = gateway.createOutbound({
        requestUri: 'sip:15551234567@carrier.example.com',
        sdp: 'local-offer-sdp',
        controlConnectionId: 'conn-1',
        outboundAttemptId: 'attempt-1'
    });

    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(gateway.cancelOutbound('attempt-1', 'conn-2'), /another control connection/);
    assert.equal(srf.cancelCalls, 0);

    await gateway.cancelOutbound('attempt-1', 'conn-1');
    srf.rejectUac(new Error('Sip non-success response: 487'));
    await assert.rejects(creation, /487/);
});

test('terminates SIP calls owned by a disconnected control connection', async () => {
    const registry = new CallRegistry();
    const controlHub = new FakeControlHub({});
    const srf = new FakeSrf();
    const gateway = new DrachtioGateway(config([]), registry, new FakeHttpClient([]), srf as any, controlHub as any);

    await gateway.createOutbound({
        requestUri: 'sip:15551234567@carrier.example.com',
        sdp: 'local-offer-sdp',
        controlConnectionId: 'conn-1'
    });
    const termination = gateway.terminateCallsForControlConnection('conn-1');

    assert.equal(registry.size, 0);
    await termination;
    assert.equal(srf.destroyedDialogs, 1);
    assert.equal(controlHub.events.length, 1);
    assert.equal(controlHub.events[0].event.event, 'sip.terminated');
    assert.equal((controlHub.events[0].event.data as any).reason, 'control-disconnected');
});

class FakeHttpClient implements GatewayHttpClient {
    posts: { url: string; body: unknown; timeoutMs: number }[] = [];

    constructor(private responses: unknown[]) {}

    async postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
        this.posts.push({ url, body, timeoutMs });
        return this.responses.shift() as T;
    }
}

class FakeSrf {
    createdUas?: { req: unknown; res: unknown; opts: unknown };
    createdUac?: { uri: string; opts: unknown };
    createUasError?: Error;
    destroyedDialogs = 0;
    connectCalls = 0;
    connectOptions?: FakeSrfConnectOptions;

    async connect(options?: FakeSrfConnectOptions) {
        this.connectCalls++;
        this.connectOptions = options;
    }
    on() {
        return this;
    }
    invite() {}

    async createUAS(req: unknown, res: unknown, opts: unknown) {
        this.createdUas = { req, res, opts };
        if (this.createUasError) throw this.createUasError;
        return this.createDialog();
    }

    async createUAC(uri: string, opts: unknown) {
        this.createdUac = { uri, opts };
        const dialog = this.createDialog();
        dialog.sip = { callId: 'outbound@example.com' };
        dialog.local = { sdp: (opts as any).localSdp };
        dialog.remote = { sdp: 'remote-answer-sdp' };
        return dialog;
    }

    private createDialog() {
        const dialog = new EventEmitter() as any;
        dialog.destroy = (_opts: unknown, callback: (err?: Error) => void) => {
            this.destroyedDialogs++;
            callback();
        };
        return dialog;
    }
}

class PendingFakeSrf extends FakeSrf {
    cancelCalls = 0;
    private rejectPendingUac?: (err: Error) => void;

    override async createUAC(uri: string, opts: unknown, progressCallbacks?: { cbRequest?: (...args: any[]) => void }): Promise<any> {
        this.createdUac = { uri, opts };
        progressCallbacks?.cbRequest?.(null, {
            cancel: (callback: (err?: Error) => void) => {
                this.cancelCalls++;
                callback();
            }
        });
        return new Promise((_resolve, reject) => {
            this.rejectPendingUac = reject;
        });
    }

    rejectUac(err: Error) {
        this.rejectPendingUac?.(err);
    }
}

class FakeControlHub {
    requests: { connectionId: string; method: string; params: unknown; timeoutMs: number }[] = [];
    events: { connectionId: string; event: { event: string; sessionId?: string; data?: unknown } }[] = [];

    constructor(private response: unknown) {}

    findRoute(): ControlRouteMatch {
        return {
            connectionId: 'conn-1',
            route: { match: 'exact', value: 'support', url: 'control://conn-1' }
        };
    }

    async request(connectionId: string, method: string, params: unknown, timeoutMs: number) {
        this.requests.push({ connectionId, method, params, timeoutMs });
        return this.response;
    }

    isConnected() {
        return true;
    }

    sendEvent(connectionId: string, event: { event: string; sessionId?: string; data?: unknown }) {
        this.events.push({ connectionId, event });
        return true;
    }
}

class FakeResponse {
    finalResponseSent = false;
    sent?: { status: number; reason?: string; opts?: unknown };

    send(status: number, reason?: string | object, opts?: unknown) {
        this.finalResponseSent = status >= 200;
        if (typeof reason === 'object') {
            this.sent = { status, opts: reason };
        } else {
            this.sent = { status, reason, opts };
        }
    }
}

function fakeInvite() {
    const headers = {
        'call-id': 'abc@example.com',
        from: '<sip:+15551234567@example.net>',
        to: '<sip:support@example.net>',
        contact: '<sip:caller@example.net>'
    };
    return {
        uri: 'sip:support@example.net',
        callId: 'abc@example.com',
        headers,
        body: 'remote-sdp',
        sdp: 'remote-sdp',
        from: headers.from,
        to: headers.to,
        get: (name: string) => headers[name.toLowerCase() as keyof typeof headers]
    };
}

function config(routes: GatewayConfig['ROUTES']): GatewayConfig {
    return {
        DRACHTIO_HOST: '127.0.0.1',
        DRACHTIO_PORT: 9022,
        HTTP_PORT: 3001,
        CONTROL_WS_PATH: '/control',
        CONTROL_AUTH_MODE: 'none',
        CONTROL_MAX_PAYLOAD_BYTES: 1_048_576,
        CONTROL_REQUEST_TIMEOUT_MS: 15_000,
        INVITE_HTTP_TIMEOUT_MS: 15_000,
        EVENT_HTTP_TIMEOUT_MS: 15_000,
        ROUTES: routes
    };
}
