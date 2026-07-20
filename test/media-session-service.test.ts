import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { MediaSessionService, MediaUnavailableError } from '../src/media-session-service';

test('media session service forwards rtpbridge events to the owner control connection', async () => {
    const client = new FakeRtpbridgeClient();
    const publisher = new FakePublisher();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', publisher);

    const session = await service.createSession({ callId: 'call-1', ownerConnectionId: 'conn-1' });
    client.emit('rtpbridge.event', { event: 'endpoint.ice_state_changed', data: { endpointId: 'ep-1', iceState: 'disconnected' } });

    assert.equal(session.sessionId, 'media-session-1');
    assert.deepEqual(publisher.events, [
        {
            connectionId: 'conn-1',
            event: {
                event: 'media.rtpbridge',
                sessionId: 'media-session-1',
                data: { event: 'endpoint.ice_state_changed', data: { endpointId: 'ep-1', iceState: 'disconnected' } }
            }
        }
    ]);
});

test('media session service destroys sessions owned by a disconnected control connection', async () => {
    const clientA = new FakeRtpbridgeClient('media-session-a');
    const clientB = new FakeRtpbridgeClient('media-session-b');
    const manager = new FakeMediaServerManager(clientA, clientB);
    const service = new MediaSessionService(manager as any, '/recordings', new FakePublisher());

    await service.createSession({ callId: 'call-a', ownerConnectionId: 'conn-a' });
    await service.createSession({ callId: 'call-b', ownerConnectionId: 'conn-b' });

    const destruction = service.destroySessionsForOwner('conn-a');

    assert.equal(service.get('media-session-a'), undefined);
    await destruction;
    assert.deepEqual(clientA.destroyedSessions, ['media-session-a']);
    assert.deepEqual(clientB.destroyedSessions, []);
    assert.equal(service.get('media-session-b')?.sessionId, 'media-session-b');
});

test('media session service reuses pending ICE restart until the matching answer is accepted', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createWebrtcOffer('media-session-1');

    const first = await service.restartIce('webrtc-1');
    const second = await service.restartIce('webrtc-1');
    assert.deepEqual(first, { sdpOffer: 'restart-sdp-1', offerGeneration: 1 });
    assert.deepEqual(second, first);
    assert.equal(client.iceRestartCalls, 1);

    await service.acceptWebrtcAnswer('webrtc-1', { sdp: 'answer-sdp', offerGeneration: 1 });
    const third = await service.restartIce('webrtc-1');
    assert.deepEqual(third, { sdpOffer: 'restart-sdp-2', offerGeneration: 2 });
    assert.equal(client.iceRestartCalls, 2);
});

test('media session service returns renewable ICE credentials for the coturn cohosted with its selected backend', async () => {
    const client = new FakeRtpbridgeClient('media-session-1', 'rtpbridge-0', '108.85.76.234');
    const service = new MediaSessionService(
        new FakeMediaServerManager(client) as any,
        '/recordings',
        undefined,
        10_000,
        { authSecret: 'turn-secret', credentialTtlSeconds: 86_400 }
    );

    const session = await service.createSession({ ownerConnectionId: 'conn-1' });
    assert.equal(session.iceConfiguration?.backendId, 'rtpbridge-0');
    assert.equal(session.iceConfiguration?.mediaIp, '108.85.76.234');
    assert.deepEqual(session.iceConfiguration?.servers[0], { urls: ['stun:108.85.76.234:3478'] });
    assert.deepEqual(session.iceConfiguration?.servers[1]?.urls, [
        'turn:108.85.76.234:3478?transport=udp',
        'turn:108.85.76.234:3478?transport=tcp',
        'turns:ip-108-85-76-234.zynoinfra.net:443?transport=tcp'
    ]);

    const turn = session.iceConfiguration!.servers[1]!;
    assert.match(turn.username!, /^\d+:rtc-session-media-session-1$/);
    assert.equal(turn.credential, createHmac('sha1', 'turn-secret').update(turn.username!).digest('base64'));
    assert.ok(Date.parse(session.iceConfiguration!.expiresAt) > Date.now() + 23 * 60 * 60 * 1000);

    await service.createWebrtcOffer(session.sessionId);
    const restart = await service.restartIce('webrtc-1');
    assert.equal(restart.iceConfiguration?.backendId, 'rtpbridge-0');
    assert.equal(restart.iceConfiguration?.mediaIp, '108.85.76.234');
});

test('media session ICE configuration follows each newly selected rtpbridge backend', async () => {
    const clientA = new FakeRtpbridgeClient('media-session-a', 'rtpbridge-0', '108.85.76.234');
    const clientB = new FakeRtpbridgeClient('media-session-b', 'rtpbridge-1', '108.85.76.233');
    const service = new MediaSessionService(
        new FakeMediaServerManager(clientA, clientB) as any,
        '/recordings',
        undefined,
        10_000,
        { authSecret: 'turn-secret', credentialTtlSeconds: 86_400 }
    );

    const first = await service.createSession();
    const replacement = await service.createSession();

    assert.deepEqual(
        [first, replacement].map(session => [session.backendId, session.iceConfiguration?.mediaIp]),
        [
            ['rtpbridge-0', '108.85.76.234'],
            ['rtpbridge-1', '108.85.76.233']
        ]
    );
});

test('media session setup fails closed when rtpbridge reports an invalid coturn media IP', async () => {
    const client = new FakeRtpbridgeClient('media-session-1', 'rtpbridge-0', '999.85.76.234');
    const service = new MediaSessionService(
        new FakeMediaServerManager(client) as any,
        '/recordings',
        undefined,
        10_000,
        { authSecret: 'turn-secret', credentialTtlSeconds: 86_400 }
    );

    await assert.rejects(service.createSession(), MediaUnavailableError);
    assert.deepEqual(client.destroyedSessions, ['media-session-1']);
});

test('media session service gathers DTMF locally from an endpoint', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');

    const promise = service.gather('media-session-1', {
        endpointId: 'rtp-1',
        numDigits: 2,
        timeoutMs: 1000
    });

    client.emit('dtmf', { endpointId: 'rtp-1', digit: '4' });
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '5' });

    assert.deepEqual(await promise, { digits: '45', reason: 'digits' });
});

test('media session service stops playback when playAndGather collects a digit', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');

    const promise = service.playAndGather('media-session-1', {
        endpointId: 'rtp-1',
        source: 'https://audio.example.com/menu.wav',
        numDigits: 1,
        timeoutMs: 1000
    });

    await new Promise(resolve => setImmediate(resolve));
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '7' });

    assert.deepEqual(await promise, {
        digits: '7',
        reason: 'digits',
        playbackEndpointId: 'file-1'
    });
    assert.deepEqual(client.removedEndpoints, ['file-1']);
});

test('media session service waits for VAD silence before playing leave-message media', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/var/lib/rtpbridge/recordings');

    await service.createSession({ callId: 'call-42' });
    await service.createRtpOffer('media-session-1');

    const promise = service.leaveMessage('media-session-1', {
        endpointId: 'rtp-1',
        messageSource: 'https://audio.example.com/campaign-message.wav',
        maxWaitMs: 5000,
        silenceIntervalMs: 2000
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.startedVad, [{ endpointId: 'rtp-1', options: { silenceIntervalMs: 2000, speechThreshold: undefined } }]);

    client.emit('vad.silence', { endpointId: 'rtp-1', silenceMs: 2000 });
    await new Promise(resolve => setImmediate(resolve));
    client.emit('endpoint.file.finished', { endpointId: 'file-1', reason: 'eof' });

    assert.deepEqual(await promise, { terminator: 'silence', messagePlayed: true });
    assert.deepEqual(client.stoppedVad, ['rtp-1']);
    assert.deepEqual(client.fileSources, ['https://audio.example.com/campaign-message.wav']);
    assert.deepEqual(client.removedEndpoints, ['file-1']);
});

test('media session service does not play leave-message media when terminated by DTMF', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/var/lib/rtpbridge/recordings');

    await service.createSession({ callId: 'call-42' });
    await service.createRtpOffer('media-session-1');

    const promise = service.leaveMessage('media-session-1', {
        endpointId: 'rtp-1',
        messageSource: 'https://audio.example.com/campaign-message.wav',
        maxWaitMs: 5000,
        terminator: '#'
    });

    await new Promise(resolve => setImmediate(resolve));
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '#' });

    assert.deepEqual(await promise, { terminator: 'dtmf', messagePlayed: false });
    assert.deepEqual(client.stoppedVad, ['rtp-1']);
    assert.deepEqual(client.fileSources, []);
});

test('media session service cancels pending gather when endpoint is stopped', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');

    const promise = service.gather('media-session-1', {
        endpointId: 'rtp-1',
        timeoutMs: 5000
    });

    await new Promise(resolve => setImmediate(resolve));
    await service.stopMedia('rtp-1');

    assert.deepEqual(await promise, { digits: '', reason: 'cancelled' });
    assert.deepEqual(client.removedEndpoints, ['rtp-1']);
});

test('media session service updates endpoint direction through rtpbridge', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createWebrtcOffer('media-session-1', { direction: 'sendrecv' });

    assert.deepEqual(await service.updateDirection('webrtc-1', 'inactive'), { ok: true });
    assert.deepEqual(client.updatedDirections, [{ endpointId: 'webrtc-1', direction: 'inactive' }]);
    assert.equal(service.get('media-session-1')?.endpoints[0]?.direction, 'inactive');
});

test('media session service bridges and unbridges paired sessions', async () => {
    const clientA = new FakeRtpbridgeClient('media-session-a');
    const clientB = new FakeRtpbridgeClient('media-session-b');
    const service = new MediaSessionService(new FakeMediaServerManager(clientA, clientB) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createSession({ ownerConnectionId: 'conn-1' });

    assert.deepEqual(await service.bridge('media-session-a', {
        targetSessionId: 'media-session-b',
        direction: 'sendrecv'
    }), {
        sessionId: 'media-session-a',
        endpointId: 'bridge-a-1',
        targetSessionId: 'media-session-b',
        targetEndpointId: 'bridge-b-1'
    });
    assert.deepEqual(clientA.bridgedSessions, [{ targetSessionId: 'media-session-b', direction: 'sendrecv' }]);
    assert.deepEqual(service.get('media-session-a')?.endpoints, [{
        endpointId: 'bridge-a-1',
        type: 'bridge',
        direction: 'sendrecv',
        pairedSessionId: 'media-session-b',
        pairedEndpointId: 'bridge-b-1',
        createdAt: service.get('media-session-a')?.endpoints[0]?.createdAt
    }]);
    assert.equal(service.get('media-session-b')?.endpoints[0]?.endpointId, 'bridge-b-1');
    assert.equal(service.get('media-session-b')?.endpoints[0]?.pairedEndpointId, 'bridge-a-1');

    assert.deepEqual(await service.unbridge('bridge-a-1'), { ok: true });
    assert.deepEqual(clientA.removedEndpoints, ['bridge-a-1']);
    assert.deepEqual(service.get('media-session-a')?.endpoints, []);
    assert.deepEqual(service.get('media-session-b')?.endpoints, []);
});

test('media session service defaults bridge direction to sendrecv', async () => {
    const clientA = new FakeRtpbridgeClient('media-session-a');
    const clientB = new FakeRtpbridgeClient('media-session-b');
    const service = new MediaSessionService(new FakeMediaServerManager(clientA, clientB) as any);

    await service.createSession();
    await service.createSession();

    await service.bridge('media-session-a', { targetSessionId: 'media-session-b' });

    assert.deepEqual(clientA.bridgedSessions, [{ targetSessionId: 'media-session-b', direction: 'sendrecv' }]);
    assert.equal(service.get('media-session-a')?.endpoints[0]?.direction, 'sendrecv');
    assert.equal(service.get('media-session-b')?.endpoints[0]?.direction, 'sendrecv');
});

test('media session service cleans up bridge endpoint if a session is destroyed during bridge creation', async () => {
    const clientA = new FakeRtpbridgeClient('media-session-a');
    const clientB = new FakeRtpbridgeClient('media-session-b');
    const service = new MediaSessionService(new FakeMediaServerManager(clientA, clientB) as any);
    let releaseBridge!: () => void;
    let bridgeStarted!: () => void;
    const bridgeStartedPromise = new Promise<void>(resolve => { bridgeStarted = resolve; });
    clientA.bridgeSessionStarted = bridgeStarted;
    clientA.bridgeSessionDelay = new Promise<void>(resolve => { releaseBridge = resolve; });

    await service.createSession();
    await service.createSession();

    const bridgePromise = service.bridge('media-session-a', { targetSessionId: 'media-session-b' });
    await bridgeStartedPromise;
    await service.destroySession('media-session-b');
    releaseBridge();

    await assert.rejects(bridgePromise, /destroyed while bridge was being created/);
    assert.deepEqual(clientA.removedEndpoints, ['bridge-a-1']);
    assert.deepEqual(service.get('media-session-a')?.endpoints, []);
    assert.equal(service.get('media-session-b'), undefined);
});

test('media session service rejects bridges across rtpbridge backends', async () => {
    const clientA = new FakeRtpbridgeClient('media-session-a', 'rtpbridge-a');
    const clientB = new FakeRtpbridgeClient('media-session-b', 'rtpbridge-b');
    const service = new MediaSessionService(new FakeMediaServerManager(clientA, clientB) as any);

    await service.createSession();
    await service.createSession();

    await assert.rejects(
        () => service.bridge('media-session-a', { targetSessionId: 'media-session-b' }),
        /different rtpbridge backends/
    );
    assert.deepEqual(clientA.bridgedSessions, []);
});

test('media session service returns backend-aware recording paths on start and stop', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/var/lib/rtpbridge/recordings');

    await service.createSession({ callId: 'call-42' });
    const started = await service.startRecording('media-session-1', {
        filePath: '/var/lib/rtpbridge/recordings/call_42.pcap'
    });
    const stopped = await service.stopRecording('rec-1');

    assert.deepEqual(started, {
        recordingId: 'rec-1',
        backendId: 'rtpbridge-0',
        filePath: '/var/lib/rtpbridge/recordings/call_42.pcap',
        recordingPath: 'call_42.pcap',
        downloadPath: '/recordings/rtpbridge-0/call_42.pcap'
    });
    assert.deepEqual(stopped, {
        filePath: '/var/lib/rtpbridge/recordings/call_42.pcap',
        durationMs: 1000,
        packets: 10,
        backendId: 'rtpbridge-0',
        recordingPath: 'call_42.pcap',
        downloadPath: '/recordings/rtpbridge-0/call_42.pcap'
    });
});

test('media session service constrains recording start paths to the configured root', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/var/lib/rtpbridge/recordings');

    await service.createSession({ callId: 'call-42' });

    await assert.rejects(
        () => service.startRecording('media-session-1', { filePath: '/tmp/outside.pcap' }),
        /recording filePath must be inside configured recordings path/
    );
    await assert.rejects(
        () => service.startRecording('media-session-1', { filePath: '../outside.pcap' }),
        /recording filePath must be inside configured recordings path/
    );

    const started = await service.startRecording('media-session-1', { filePath: 'nested/call_42.pcap' });
    assert.equal(started.filePath, '/var/lib/rtpbridge/recordings/nested/call_42.pcap');
    assert.equal(started.recordingPath, 'nested/call_42.pcap');
    assert.deepEqual(client.startRecordingPaths, ['/var/lib/rtpbridge/recordings/nested/call_42.pcap']);
});

test('media session service rejects unsafe recording proxy paths before backend request', async () => {
    const service = new MediaSessionService(new FakeMediaServerManager(new FakeRtpbridgeClient()) as any);

    await assert.rejects(
        () => service.downloadRecording('rtpbridge-0', '../outside.pcap'),
        /Invalid recording path/
    );
    await assert.rejects(
        () => service.downloadRecording('rtpbridge-0', '%2e%2e/outside.pcap'),
        /Invalid recording path/
    );
});

test('media session service treats 204 recording delete as success', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.statusCode = 204;
        res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const manager = new FakeMediaServerManager(new FakeRtpbridgeClient());
    manager.backendHttpUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const service = new MediaSessionService(manager as any, '/recordings', undefined, 1000);

    try {
        assert.deepEqual(await service.deleteRecording('rtpbridge-0', 'call_42.pcap'), { deleted: true });
        assert.deepEqual(requests, ['DELETE /recordings/call_42.pcap']);
    } finally {
        server.close();
    }
});

test('media session service merges recording targets into one PCAP stream', async () => {
    const firstPacket = pcapPacket('first');
    const secondPacket = pcapPacket('second');
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if (req.method === 'GET' && req.url === '/recordings/call-42/seg-1.pcap') {
            res.setHeader('content-type', 'application/vnd.tcpdump.pcap');
            res.end(pcapFile(firstPacket));
            return;
        }
        if (req.method === 'GET' && req.url === '/recordings/call-42/seg-2.pcap') {
            res.setHeader('content-type', 'application/vnd.tcpdump.pcap');
            res.end(pcapFile(secondPacket));
            return;
        }
        res.statusCode = 404;
        res.end('not found');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const manager = new FakeMediaServerManager(new FakeRtpbridgeClient());
    manager.backendHttpUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const service = new MediaSessionService(manager as any, '/recordings', undefined, 1000);

    try {
        const merged = await service.mergeRecordings([
            { backendId: 'rtpbridge-0', path: 'call-42/seg-1.pcap' },
            { backendId: 'rtpbridge-1', path: 'call-42/seg-2.pcap' }
        ]);

        assert.equal(merged.status, 200);
        assert.equal(merged.headers['content-type'], 'application/vnd.tcpdump.pcap');
        assert.deepEqual(await streamToBuffer(merged.stream), Buffer.concat([PCAP_HEADER, firstPacket, secondPacket]));
        assert.deepEqual(requests, [
            'GET /recordings/call-42/seg-1.pcap',
            'GET /recordings/call-42/seg-2.pcap'
        ]);
    } finally {
        server.close();
    }
});

test('media session service rejects incompatible PCAP segments during merge', async () => {
    const first = pcapFile(pcapPacket('first'));
    const secondHeader = Buffer.from(PCAP_HEADER);
    secondHeader.writeUInt32LE(127, 20);
    const second = Buffer.concat([secondHeader, pcapPacket('second')]);
    const server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/vnd.tcpdump.pcap');
        res.end(req.url?.endsWith('seg-1.pcap') ? first : second);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const manager = new FakeMediaServerManager(new FakeRtpbridgeClient());
    manager.backendHttpUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const service = new MediaSessionService(manager as any, '/recordings', undefined, 1000);

    try {
        await assert.rejects(
            () => service.mergeRecordings([
                { backendId: 'rtpbridge-0', path: 'seg-1.pcap' },
                { backendId: 'rtpbridge-0', path: 'seg-2.pcap' }
            ]),
            /PCAP segments have incompatible headers/
        );
    } finally {
        server.close();
    }
});

class FakePublisher {
    events: Array<{ connectionId: string; event: { event: string; sessionId?: string; data?: unknown } }> = [];

    sendEvent(connectionId: string, event: { event: string; sessionId?: string; data?: unknown }) {
        this.events.push({ connectionId, event });
        return true;
    }
}

const PCAP_HEADER = (() => {
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0xa1b2c3d4, 0);
    header.writeUInt16LE(2, 4);
    header.writeUInt16LE(4, 6);
    header.writeUInt32LE(65535, 16);
    header.writeUInt32LE(1, 20);
    return header;
})();

function pcapPacket(payload: string) {
    const body = Buffer.from(payload);
    const record = Buffer.alloc(16);
    record.writeUInt32LE(1, 0);
    record.writeUInt32LE(0, 4);
    record.writeUInt32LE(body.length, 8);
    record.writeUInt32LE(body.length, 12);
    return Buffer.concat([record, body]);
}

function pcapFile(...packets: Buffer[]) {
    return Buffer.concat([PCAP_HEADER, ...packets]);
}

async function streamToBuffer(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

class FakeMediaServerManager {
    private index = 0;
    backendHttpUrl = 'http://127.0.0.1:9';

    constructor(private clients: FakeRtpbridgeClient[] | FakeRtpbridgeClient, ...rest: FakeRtpbridgeClient[]) {
        if (!Array.isArray(clients)) this.clients = [clients, ...rest];
    }

    async createClient() {
        return (this.clients as FakeRtpbridgeClient[])[this.index++];
    }

    async resolveBackend(backendId: string) {
        return { id: backendId, url: `ws://${backendId}:9100`, httpUrl: this.backendHttpUrl };
    }

    async resolveBackends() {
        return [await this.resolveBackend('rtpbridge-0')];
    }

    unregisterCall() {}
}

class FakeRtpbridgeClient extends EventEmitter {
    backendId: string;
    destroyedSessions: string[] = [];
    iceRestartCalls = 0;
    recordingFilePath = '/var/lib/rtpbridge/recordings/call_42.pcap';
    startRecordingPaths: string[] = [];
    removedEndpoints: string[] = [];
    startedVad: Array<{ endpointId: string; options: unknown }> = [];
    stoppedVad: string[] = [];
    injectedDtmf: Array<{ endpointId: string; digit: string }> = [];
    updatedDirections: Array<{ endpointId: string; direction: string }> = [];
    bridgedSessions: Array<{ targetSessionId: string; direction?: string }> = [];
    bridgeSessionDelay?: Promise<void>;
    bridgeSessionStarted?: () => void;
    fileSources: string[] = [];

    constructor(
        private sessionId = 'media-session-1',
        backendId = 'rtpbridge-0',
        private mediaIp = '108.85.76.234'
    ) {
        super();
        this.backendId = backendId;
    }

    get backendHost() {
        return this.backendId;
    }

    async getServerInfo() {
        return { hostname: this.backendId, mediaIp: this.mediaIp };
    }

    async createSession() {
        return this.sessionId;
    }

    async destroySession(sessionId: string) {
        this.destroyedSessions.push(sessionId);
    }

    async createWebrtcOffer() {
        return { endpointId: 'webrtc-1', sdpOffer: 'offer-sdp' };
    }

    async acceptWebrtcAnswer() {}

    async createRtpOffer() {
        return { endpointId: 'rtp-1', sdpOffer: 'rtp-offer-sdp' };
    }

    async iceRestart() {
        this.iceRestartCalls++;
        return {
            sdpOffer: `restart-sdp-${this.iceRestartCalls}`,
            offerGeneration: this.iceRestartCalls
        };
    }

    async createFileEndpoint(_sessionId: string, params: { source: string }) {
        this.fileSources.push(params.source);
        return { endpointId: 'file-1' };
    }

    async createToneEndpoint() {
        return { endpointId: 'tone-1' };
    }

    async removeEndpoint(endpointId: string) {
        this.removedEndpoints.push(endpointId);
    }

    async injectDtmf(endpointId: string, digit: string) {
        this.injectedDtmf.push({ endpointId, digit });
    }

    async updateDirection(endpointId: string, direction: string) {
        this.updatedDirections.push({ endpointId, direction });
    }

    async bridgeSession(targetSessionId: string, params: { direction?: string }) {
        this.bridgedSessions.push({ targetSessionId, direction: params.direction });
        this.bridgeSessionStarted?.();
        await this.bridgeSessionDelay;
        return { endpointId: 'bridge-a-1', targetEndpointId: 'bridge-b-1' };
    }

    async startRecording(_sessionId: string, params: { filePath: string }) {
        this.recordingFilePath = params.filePath;
        this.startRecordingPaths.push(params.filePath);
        return { recordingId: 'rec-1' };
    }

    async stopRecording() {
        return { filePath: this.recordingFilePath, durationMs: 1000, packets: 10 };
    }

    async startVad(endpointId: string, options: unknown) {
        this.startedVad.push({ endpointId, options });
    }

    async stopVad(endpointId: string) {
        this.stoppedVad.push(endpointId);
    }

    close() {}

    onClose(handler: () => void) {
        this.on('close', handler);
    }
}
