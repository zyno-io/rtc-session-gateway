import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { AcceptanceOwner } from '../src/acceptance/owner';
import { AcceptanceClient, AcceptanceError } from '../src/acceptance/client';
import { startAcceptance } from '../src/acceptance/main';

const invite = {
    type: 'request' as const,
    id: 'invite-1',
    method: 'sip.invite',
    params: { callId: 'call-1', destinationUser: 'rtc-acceptance', sdp: 'synthetic-offer' }
};
function fixture() {
    const calls: { method: string; params: any }[] = [];
    const client = {
        async request(method: string, params: any) {
            calls.push({ method, params });
            if (method === 'session.create') return { sessionId: 'media-1' };
            if (method === 'rtp.createFromOffer' || method === 'rtp.reinvite') return { endpointId: 'rtp-1', sdpAnswer: 'synthetic-answer' };
            return {};
        }
    };
    return { calls, client, owner: new AcceptanceOwner(client, 'rtc-acceptance') };
}
async function until(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Condition timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
test('acceptance owner uses public media APIs once per request and cleans up remote BYE', async () => {
    const { owner, calls } = fixture();
    await owner.register();
    const result = await owner.handle(invite);
    assert.deepEqual(result, { action: 'answer', sdp: 'synthetic-answer' });
    assert.deepEqual(await owner.handle(invite), result);
    assert.equal(calls.filter(call => call.method === 'session.create').length, 1);
    await assert.rejects(owner.handle({ ...invite, params: { ...invite.params, sdp: 'different-offer' } }), /REQUEST_REPLAY_MISMATCH/);
    await owner.handle({ ...invite, id: 'reinvite', method: 'sip.reinvite' });
    assert.equal(calls.find(call => call.method === 'rtp.reinvite')?.params.endpointId, 'rtp-1');
    await owner.event({ type: 'event', event: 'sip.bye', eventId: 'bye', occurredAt: new Date().toISOString(), data: { callId: 'call-1' } });
    assert.equal(owner.activeCalls, 0);
    assert.ok(calls.some(call => call.method === 'session.delete'));
});
test('native cancellation while media allocation is pending cannot answer or leak the late session', async () => {
    const allocation = Promise.withResolvers<any>();
    const deleted: unknown[] = [];
    const owner = new AcceptanceOwner(
        {
            async request(method, params) {
                if (method === 'session.create') return allocation.promise;
                if (method === 'session.delete') deleted.push(params);
                else assert.fail('no RTP endpoint should be allocated after cancellation');
            }
        },
        'rtc-acceptance'
    );
    const pending = owner.handle(invite);
    await owner.event({ type: 'event', event: 'sip.terminated', eventId: 'cancel', occurredAt: '', data: { callId: 'call-1' } });
    allocation.resolve({ sessionId: 'late-media' });
    assert.deepEqual(await pending, { action: 'reject', status: 487 });
    assert.deepEqual(deleted, [{ sessionId: 'late-media' }]);
    assert.equal(owner.activeCalls, 0);
});
test('acceptance owner rejects only its exact reject route without allocating media', async () => {
    const { owner, calls } = fixture();
    assert.deepEqual(await owner.handle({ ...invite, params: { ...invite.params, destinationUser: 'rtc-acceptance-reject' } }), {
        action: 'reject',
        status: 486
    });
    assert.equal(calls.length, 0);
    assert.throws(() => new AcceptanceOwner({ request: async () => ({}) }, 'support'), /INVALID_TEST_ROUTE/);
});
async function mockGateway(handler: (frame: any, respond: (result: any) => void) => void) {
    const http = createServer();
    const sockets = new WebSocketServer({ server: http });
    sockets.on('connection', (socket, request) => {
        if (request.headers.authorization !== 'Bearer synthetic-acceptance-token') {
            socket.close();
            return;
        }
        socket.send(
            JSON.stringify({
                type: 'event',
                event: 'control.connected',
                eventId: 'connected',
                occurredAt: new Date().toISOString(),
                data: { connectionId: 'owner' }
            })
        );
        socket.on('message', bytes => {
            const frame = JSON.parse(bytes.toString());
            handler(frame, result => socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result })));
        });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    return {
        url: `ws://127.0.0.1:${(http.address() as any).port}/control`,
        async close() {
            for (const socket of sockets.clients) socket.terminate();
            await new Promise<void>(resolve => sockets.close(() => http.close(() => resolve())));
        }
    };
}
test('public owner client reports a lost reply as unknown and never retries the mutation', async () => {
    let writes = 0;
    const gateway = await mockGateway(() => {
        writes++;
    });
    const client = new AcceptanceClient(gateway.url, 'synthetic-acceptance-token', { timeoutMs: 30 });
    try {
        await client.connected;
        await assert.rejects(
            client.request('sip.createOutbound', {}),
            error => error instanceof AcceptanceError && error.code === 'RPC_OUTCOME_UNKNOWN'
        );
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(writes, 1);
    } finally {
        client.close();
        await gateway.close();
    }
});
test('controller bootstraps before gateway readiness; authenticated smoke reports contain no credentials or SDP', async () => {
    const calls: any[] = [];
    const gateway = await mockGateway((frame, respond) => {
        calls.push(frame);
        respond(
            frame.method === 'session.create'
                ? { sessionId: 'session' }
                : frame.method === 'rtp.createOffer'
                  ? { endpointId: 'endpoint', sdpOffer: 'private-synthetic-sdp' }
                  : frame.method === 'webrtc.createOffer'
                    ? { sdpOffer: 'private-webrtc-sdp' }
                    : frame.method === 'recording.start'
                      ? { recordingId: 'recording', backendId: 'backend', recordingPath: 'sg_acceptance.pcap' }
                      : {}
        );
    });
    const directory = mkdtempSync(join(tmpdir(), 'rtc-owner-'));
    const file = join(directory, 'token');
    writeFileSync(file, 'synthetic-acceptance-token');
    const controller = await startAcceptance({ RTC_ACCEPTANCE_CONTROL_URL: gateway.url, RTC_ACCEPTANCE_TOKEN_FILE: file, RTC_ACCEPTANCE_PORT: '0' });
    const url = `http://127.0.0.1:${(controller.server.address() as any).port}`;
    try {
        await until(() => controller.report().controllerReady);
        assert.equal((await fetch(url + '/report')).status, 401);
        const response = await fetch(url + '/run', {
            method: 'POST',
            headers: { Authorization: 'Bearer synthetic-acceptance-token' },
            body: JSON.stringify({ scenario: 'media' })
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.scope, 'control-plane-smoke-no-audio-proof');
        const report = JSON.stringify(controller.report());
        assert.equal(report.includes('synthetic-acceptance-token'), false);
        assert.equal(report.includes('private-synthetic-sdp'), false);
        assert.ok(calls.some(frame => frame.method === 'recording.delete' && frame.params.path === 'sg_acceptance.pcap'));
        assert.ok(calls.some(frame => frame.method === 'session.delete'));
    } finally {
        await controller.stop();
        await gateway.close();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('SIP acceptance peer verifies TLS and uses the configured logical SIP domain', async () => {
    const tls = await import('node:tls');
    const { readFileSync } = await import('node:fs');
    const { SipStreamPeer } = await import('../scripts/support/sip-stream-peer.mjs');
    const cert = readFileSync('test/fixtures/rtpbridge-cert.pem');
    const key = readFileSync('test/fixtures/rtpbridge-key.pem');
    const sockets = new Set<any>();
    const server = tls.createServer({ cert, key }, socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as any).port;
    let peer;
    try {
        await assert.rejects(SipStreamPeer.create({ host: '127.0.0.1', port, domain: 'wrong.test', tls: true, ca: cert }));
        peer = await SipStreamPeer.create({ host: '127.0.0.1', port, domain: 'rtpbridge.test', tls: true, ca: cert, advertisedHost: '127.0.0.1' });
        const invite = peer.buildInvite({ user: 'rtc-acceptance', sdp: 'fixture-sdp' });
        assert.ok(invite.message.startsWith(`INVITE sip:rtc-acceptance@rtpbridge.test:${port}`));
        assert.ok(invite.message.includes('Via: SIP/2.0/TLS '));
    } finally {
        peer?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

test('outbound smoke retains the owner connection through answer, re-INVITE and teardown', async () => {
    const calls: string[] = [];
    const owner = new AcceptanceOwner(
        {
            async request(method) {
                calls.push(method);
                if (method === 'session.create') return { sessionId: 'media' };
                if (method === 'rtp.createOffer') return { endpointId: 'rtp', sdpOffer: 'offer' };
                if (method === 'sip.createOutbound') return { sessionId: 'call', sdp: 'answer' };
                return {};
            }
        },
        'rtc-acceptance'
    );
    const report = await owner.smoke('outbound', 'sip:fixture@example.test');
    assert.ok(report.checks.includes('outbound-answer'));
    assert.deepEqual(calls.slice(-4), ['rtp.acceptAnswer', 'sip.reinvite', 'sip.bye', 'session.delete']);
});
test('cancellation uses the original public attempt and never retries origination', async () => {
    const pending = Promise.withResolvers<any>();
    let attempt: string | undefined;
    let starts = 0;
    const owner = new AcceptanceOwner(
        {
            async request(method, params: any) {
                if (method === 'session.create') return { sessionId: 'media' };
                if (method === 'rtp.createOffer') return { endpointId: 'rtp', sdpOffer: 'offer' };
                if (method === 'sip.createOutbound') {
                    starts++;
                    attempt = params.outboundAttemptId;
                    return pending.promise;
                }
                if (method === 'sip.cancelOutbound') {
                    assert.equal(params.outboundAttemptId, attempt);
                    pending.reject(new AcceptanceError('CONFLICT'));
                }
                return {};
            }
        },
        'rtc-acceptance'
    );
    assert.ok((await owner.smoke('cancel', 'sip:fixture@example.test')).checks.includes('outbound-cancel'));
    assert.equal(starts, 1);
});
