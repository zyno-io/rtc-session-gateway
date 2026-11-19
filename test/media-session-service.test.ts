import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { MediaActionConflictError, MediaSessionService, MediaUnavailableError } from '../src/media-session-service';
import { RtpbridgeTimeoutError } from '../src/rtpbridge-client';
import { RtpbridgeTransport } from '../src/rtpbridge-transport';

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

test('concurrent deletion converges when owner teardown closes an in-flight backend request', async () => {
    for (const target of ['session', 'endpoint']) {
        const client = new FakeRtpbridgeClient();
        const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
        const session = await service.createSession({ ownerConnectionId: 'owner' });
        const endpoint = await service.createWebrtcOffer(session.sessionId);
        const pending = Promise.withResolvers<void>();
        let destroyCalls = 0;
        client.destroySession = async () => {
            if (++destroyCalls === 1 && target === 'session') await pending.promise;
        };
        client.removeEndpoint = async () => {
            await pending.promise;
        };
        const deletion = target === 'session' ? service.destroySession(session.sessionId) : service.stopMedia(endpoint.endpointId);
        deletion.catch(() => {});
        await service.destroySessionsForOwner('owner');
        pending.reject(new Error('rtpbridge socket closed'));
        await deletion;
        assert.equal(service.get(session.sessionId), undefined);
    }
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
    const client = new FakeRtpbridgeClient('media-session-1', 'rtpbridge-0', ['2001:db8::234', '108.85.76.234']);
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', undefined, 10_000, {
        authSecret: 'turn-secret',
        credentialTtlSeconds: 86_400
    });

    const session = await service.createSession({ ownerConnectionId: 'conn-1' });
    assert.equal(session.iceConfiguration?.backendId, 'rtpbridge-0');
    assert.equal(session.iceConfiguration?.mediaIp, '108.85.76.234');
    assert.deepEqual(session.iceConfiguration?.servers[0], { urls: ['stun:108.85.76.234:3478'] });
    assert.deepEqual(session.iceConfiguration?.servers[1]?.urls, ['turn:108.85.76.234:3478?transport=udp', 'turn:108.85.76.234:3478?transport=tcp']);

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
    const clientA = new FakeRtpbridgeClient('media-session-a', 'rtpbridge-0', ['108.85.76.234']);
    const clientB = new FakeRtpbridgeClient('media-session-b', 'rtpbridge-1', ['108.85.76.233']);
    const service = new MediaSessionService(new FakeMediaServerManager(clientA, clientB) as any, '/recordings', undefined, 10_000, {
        authSecret: 'turn-secret',
        credentialTtlSeconds: 86_400
    });

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
    const client = new FakeRtpbridgeClient('media-session-1', 'rtpbridge-0', ['2001:db8::234', '999.85.76.234']);
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', undefined, 10_000, {
        authSecret: 'turn-secret',
        credentialTtlSeconds: 86_400
    });

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

test('media session service redacts fanned-out DTMF events during a sensitive gather', async () => {
    const client = new FakeRtpbridgeClient();
    const publisher = new FakePublisher();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', publisher);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');

    const promise = service.gather('media-session-1', {
        endpointId: 'rtp-1',
        numDigits: 2,
        timeoutMs: 1000,
        sensitive: true
    });

    await new Promise(resolve => setImmediate(resolve));
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '4', sensitive: true });
    client.emit('rtpbridge.event', { event: 'dtmf', data: { endpointId: 'rtp-1', digit: '4', sensitive: true } });
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '5', sensitive: true });
    client.emit('rtpbridge.event', { event: 'dtmf', data: { endpointId: 'rtp-1', digit: '5', sensitive: true } });

    assert.deepEqual(await promise, { digits: '45', reason: 'digits' });
    assert.deepEqual(client.sensitiveDtmfChanges, [
        { endpointId: 'rtp-1', enabled: true },
        { endpointId: 'rtp-1', enabled: false }
    ]);
    assert.deepEqual(
        publisher.events.map(published => (published.event.data as any).data.digit),
        ['~', '~']
    );
    assert.equal(JSON.stringify(publisher.events).includes('4'), false);
    assert.equal(JSON.stringify(publisher.events).includes('5'), false);
});

test('media session service leaves normal DTMF event values visible', async () => {
    const client = new FakeRtpbridgeClient();
    const publisher = new FakePublisher();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', publisher);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    client.emit('rtpbridge.event', { event: 'dtmf', data: { endpointId: 'rtp-1', digit: '7', sensitive: false } });

    assert.equal((publisher.events[0].event.data as any).data.digit, '7');
});

test('media session service fails closed when rtpbridge cannot enable sensitive DTMF', async () => {
    const client = new FakeRtpbridgeClient();
    client.sensitiveDtmfError = new Error('privacy control unavailable');
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');

    await assert.rejects(
        service.gather('media-session-1', {
            endpointId: 'rtp-1',
            numDigits: 1,
            sensitive: true
        }),
        /privacy control unavailable/
    );
    assert.equal(client.listenerCount('dtmf'), 0);
});

test('media session service keeps redacting when rtpbridge cannot disable sensitive DTMF', async () => {
    const client = new FakeRtpbridgeClient();
    const publisher = new FakePublisher();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', publisher);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');
    const promise = service.gather('media-session-1', {
        endpointId: 'rtp-1',
        numDigits: 1,
        sensitive: true
    });
    await new Promise(resolve => setImmediate(resolve));
    client.sensitiveDtmfDisableError = new Error('privacy release unavailable');
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '8', sensitive: true });
    assert.deepEqual(await promise, { digits: '8', reason: 'digits' });

    client.emit('rtpbridge.event', { event: 'dtmf', data: { endpointId: 'rtp-1', digit: '9', sensitive: false } });
    assert.equal((publisher.events[0].event.data as any).data.digit, '~');
});

test('media session service rejects overlapping gathers while sensitive mode is being established', async () => {
    const client = new FakeRtpbridgeClient();
    let releaseSensitiveMode!: () => void;
    client.sensitiveDtmfDelay = new Promise(resolve => {
        releaseSensitiveMode = resolve;
    });
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession();
    await service.createRtpOffer('media-session-1');
    const sensitiveGather = service.gather('media-session-1', {
        endpointId: 'rtp-1',
        numDigits: 1,
        sensitive: true
    });

    await assert.rejects(service.gather('media-session-1', { endpointId: 'rtp-1', numDigits: 1 }), MediaActionConflictError);
    releaseSensitiveMode();
    await new Promise(resolve => setImmediate(resolve));
    client.emit('dtmf', { endpointId: 'rtp-1', digit: '1', sensitive: true });
    assert.deepEqual(await sensitiveGather, { digits: '1', reason: 'digits' });
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

test('media session service starts the no-input timeout again after playAndGather playback finishes', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession({ ownerConnectionId: 'conn-1' });
    await service.createRtpOffer('media-session-1');

    const startedAt = Date.now();
    const promise = service.playAndGather('media-session-1', {
        endpointId: 'rtp-1',
        source: 'https://audio.example.com/menu.wav',
        numDigits: 1,
        timeoutMs: 30,
        postPlaybackTimeoutMs: 40
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    client.emit('endpoint.file.finished', { endpointId: 'file-1', reason: 'eof' });

    assert.deepEqual(await promise, {
        digits: '',
        reason: 'timeout',
        playbackEndpointId: 'file-1'
    });
    assert.ok(Date.now() - startedAt >= 50);
    assert.deepEqual(client.removedEndpoints, ['file-1']);
});

test('media session service waits for prompt playback to finish', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);

    await service.createSession();
    const promise = service.playAndWait('media-session-1', {
        source: 'https://audio.example.com/prompt.wav',
        playbackTimeoutMs: 1000
    });

    await new Promise(resolve => setImmediate(resolve));
    client.emit('endpoint.file.finished', { endpointId: 'file-1', reason: 'eof' });

    assert.deepEqual(await promise, { played: true });
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

    assert.deepEqual(
        await service.bridge('media-session-a', {
            targetSessionId: 'media-session-b',
            direction: 'sendrecv'
        }),
        {
            sessionId: 'media-session-a',
            endpointId: 'bridge-a-1',
            targetSessionId: 'media-session-b',
            targetEndpointId: 'bridge-b-1'
        }
    );
    assert.deepEqual(clientA.bridgedSessions, [{ targetSessionId: 'media-session-b', direction: 'sendrecv' }]);
    assert.deepEqual(service.get('media-session-a')?.endpoints, [
        {
            endpointId: 'bridge-a-1',
            type: 'bridge',
            direction: 'sendrecv',
            pairedSessionId: 'media-session-b',
            pairedEndpointId: 'bridge-b-1',
            createdAt: service.get('media-session-a')?.endpoints[0]?.createdAt
        }
    ]);
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
    const bridgeStartedPromise = new Promise<void>(resolve => {
        bridgeStarted = resolve;
    });
    clientA.bridgeSessionStarted = bridgeStarted;
    clientA.bridgeSessionDelay = new Promise<void>(resolve => {
        releaseBridge = resolve;
    });

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

    await assert.rejects(() => service.bridge('media-session-a', { targetSessionId: 'media-session-b' }), /different rtpbridge backends/);
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

test('shared recording prefix fences start, list, download, merge and delete to gateway-owned files', async () => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ recordings: ['sg_call.pcap', 'talk_call.pcap'], total: 2 }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new FakeRtpbridgeClient();
    const manager = new FakeMediaServerManager(client);
    manager.backendHttpUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    const service = new MediaSessionService(manager as any, '/var/lib/rtpbridge/recordings', undefined, 1000, undefined, undefined, 'sg_');

    try {
        await service.createSession({ callId: 'call-42' });
        const started = await service.startRecording('media-session-1', {});
        assert.match(started.recordingPath, /^sg_/);
        await assert.rejects(() => service.startRecording('media-session-1', { filePath: 'talk_call.pcap' }), /outside the configured prefix/);
        const listed = await service.listRecordings();
        assert.deepEqual(listed.recordings, [{ backendId: 'rtpbridge-0', path: 'sg_call.pcap' }]);
        assert.ok(requests[0]?.includes('startsWith=sg_'));
        await assert.rejects(() => service.listRecordings({ startsWith: 'talk_' }), /outside the configured prefix/);
        await assert.rejects(() => service.downloadRecording('rtpbridge-0', 'talk_call.pcap'), /outside the configured prefix/);
        await assert.rejects(() => service.mergeRecordings([{ backendId: 'rtpbridge-0', path: 'talk_call.pcap' }]), /outside the configured prefix/);
        await assert.rejects(() => service.deleteRecording('rtpbridge-0', 'talk_call.pcap'), /outside the configured prefix/);
        assert.equal(requests.length, 1, 'rejected operations never reach shared media');
    } finally {
        server.close();
    }
});

test('media session service rejects unsafe recording proxy paths before backend request', async () => {
    const service = new MediaSessionService(new FakeMediaServerManager(new FakeRtpbridgeClient()) as any);

    await assert.rejects(() => service.downloadRecording('rtpbridge-0', '../outside.pcap'), /Invalid recording path/);
    await assert.rejects(() => service.downloadRecording('rtpbridge-0', '%2e%2e/outside.pcap'), /Invalid recording path/);
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
        assert.deepEqual(requests, ['GET /recordings/call-42/seg-1.pcap', 'GET /recordings/call-42/seg-2.pcap']);
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
            () =>
                service.mergeRecordings([
                    { backendId: 'rtpbridge-0', path: 'seg-1.pcap' },
                    { backendId: 'rtpbridge-0', path: 'seg-2.pcap' }
                ]),
            /PCAP segments have incompatible headers/
        );
    } finally {
        server.close();
    }
});

test('handoff freezes recording starts, awaits in-flight starts, and confirms all stops', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.startRecording = async (_sessionId, params) => {
        client.recordingFilePath = params.filePath;
        started.resolve();
        await release.promise;
        return { recordingId: 'rec-1' };
    };
    const recording = service.startRecording('media-session-1', {});
    await started.promise;
    const handoffToken = {};
    const handoff = service.prepareHandoff('media-session-1', 'owner', handoffToken);
    await assert.rejects(service.startRecording('media-session-1', {}), MediaActionConflictError);
    release.resolve();
    await recording;
    const results = await handoff;
    assert.equal(results.length, 1);
    assert.equal(results[0].recordingId, 'rec-1');
    assert.equal(results[0].packets, 10);
    await assert.rejects(service.stopRecording('rec-1'), /not found/);
    service.releaseHandoff('media-session-1', handoffToken);
});

test('a failed handoff attempt never stops a recording the application starts after the guard is released', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.startRecording('media-session-1', {});
    const token = {};
    const original = client.stopRecording.bind(client);
    let stops = 0;
    client.stopRecording = async (...args: Parameters<typeof original>) => {
        stops++;
        // The handoff timed out and released its guard; the application immediately records again.
        service.releaseHandoff('media-session-1', token);
        client.startRecording = async () => ({ recordingId: 'rec-2' });
        await service.startRecording('media-session-1', {});
        return original(...args);
    };
    await service.prepareHandoff('media-session-1', 'owner', token);
    assert.equal(stops, 1, 'only the recording present when the handoff began is stopped');
    client.stopRecording = original;
    assert.equal((await service.stopRecording('rec-2')).packets, 10, 'the newer recording is still active');
});

test('recording-stop failure aborts media preparation without forgetting the active recording', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.startRecording('media-session-1', {});
    const original = client.stopRecording.bind(client);
    client.stopRecording = async () => {
        throw new Error('stop rejected');
    };
    client.sessionRecordings = [{ recordingId: 'rec-1', filePath: client.recordingFilePath, state: 'active' }];
    await assert.rejects(service.prepareHandoff('media-session-1', 'owner', {}), /stop rejected/);
    client.stopRecording = original;
    const result = await service.stopRecording('rec-1');
    assert.equal(result.packets, 10);
    await assert.rejects(service.prepareHandoff('media-session-1', 'other-owner', {}), /another owner/);
    await service.createWebrtcOffer('media-session-1');
    await assert.rejects(service.prepareHandoff('media-session-1', 'owner', {}), /dedicated call/);
});

test('handoff is refused when the session carries a second RTP endpoint, and allowed with one RTP plus non-RTP endpoints', async () => {
    const client = new FakeRtpbridgeClient();
    const sdp = (port: number) =>
        ['v=0', 'o=- 1 1 IN IP4 10.0.0.3', 's=test', 'c=IN IP4 10.0.0.3', 't=0 0', `m=audio ${port} RTP/AVP 0`, ''].join('\r\n');
    let n = 0;
    client.createRtpOffer = async () => {
        n++;
        return { endpointId: `rtp-${n}`, sdpOffer: sdp(40000 + n * 2) };
    };
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.play('media-session-1', { source: 'file.wav' });
    assert.doesNotThrow(() => service.assertHandoffMedia('media-session-1', 'owner', sdp(40002)));
    await service.createRtpOffer('media-session-1');
    assert.throws(() => service.assertHandoffMedia('media-session-1', 'owner', sdp(40002)), /single RTP endpoint/);
    await assert.rejects(service.prepareHandoff('media-session-1', 'owner', {}), /single RTP endpoint/);
    assert.deepEqual(client.removedEndpoints, []);
    assert.deepEqual(client.destroyedSessions, []);
    assert.ok(service.get('media-session-1'));
});

test('late RTP endpoint reply after owner disconnect does not cache SDP or index the endpoint', async () => {
    for (const method of ['createRtpOffer', 'createRtpFromOffer'] as const) {
        const client = new FakeRtpbridgeClient();
        const gate = Promise.withResolvers<void>();
        client.createRtpOffer = async () => {
            await gate.promise;
            return { endpointId: 'rtp-late', sdpOffer: 'offer' };
        };
        client.createRtpFromOffer = async () => {
            await gate.promise;
            return { endpointId: 'rtp-late', sdpAnswer: 'answer' };
        };
        const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
        await service.createSession({ ownerConnectionId: 'owner' });
        const pending = service[method]('media-session-1', { sdp: 'x' });
        await service.destroySessionsForOwner('owner');
        gate.resolve();
        await pending;
        assert.equal((service as any).rtpLocalSdp.size, 0);
        assert.equal((service as any).endpointToSession.size, 0);
    }
});

test('handoff validates the source RTP address and retains previously finalized recording segments', async () => {
    const client = new FakeRtpbridgeClient();
    const local = ['v=0', 'o=- 1 1 IN IP4 10.0.0.3', 's=test', 'c=IN IP4 10.0.0.3', 't=0 0', 'm=audio 40000 RTP/AVP 0', ''].join('\r\n');
    client.createRtpOffer = async () => ({ endpointId: 'rtp-1', sdpOffer: local });
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    assert.doesNotThrow(() => service.assertHandoffMedia('media-session-1', 'owner', local));
    assert.throws(() => service.assertHandoffMedia('media-session-1', 'owner', local.replace('40000', '40002')), /does not carry/);
    await service.startRecording('media-session-1', { filePath: 'first.pcap' });
    await service.stopRecording('rec-1');
    const recordings = await service.prepareHandoff('media-session-1', 'owner', {});
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].recordingPath, 'first.pcap');
    await service.destroySession('media-session-1');
    assert.equal(service.size, 0);
});

test('handoff guard is owner-scoped: a stale token cannot release a newer attempt', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    const a = {};
    const b = {};
    await service.prepareHandoff('media-session-1', 'owner', a);
    service.releaseHandoff('media-session-1', a);
    await service.prepareHandoff('media-session-1', 'owner', b);
    service.releaseHandoff('media-session-1', a);
    await assert.rejects(service.startRecording('media-session-1', {}), MediaActionConflictError);
    service.releaseHandoff('media-session-1', b);
    await service.startRecording('media-session-1', {});
});

test('handoff drops a tracked recording rtpbridge no longer has when stop reports not found', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.startRecording('media-session-1', {});
    client.stopRecording = async () => {
        throw new Error('Recording not found');
    };
    client.sessionRecordings = [];
    const first = await service.prepareHandoff('media-session-1', 'owner', {});
    assert.deepEqual(
        first.map(item => [item.recordingId, item.durationMs, item.packets]),
        [['rec-1', 0, 0]]
    );
    await assert.rejects(service.stopRecording('rec-1'), /not found/);
    // A retry no longer trips over the stale id, and the entry is not duplicated.
    assert.equal((await service.prepareHandoff('media-session-1', 'owner', {})).length, 1);
});

test('a lost stop reply for a recording absent from session.info still yields its finalized entry', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.startRecording('media-session-1', {});
    client.stopRecording = async () => {
        throw new Error('timeout waiting for reply');
    };
    client.sessionRecordings = [];
    const results = await service.prepareHandoff('media-session-1', 'owner', {});
    assert.equal(results.length, 1);
    assert.equal(results[0].recordingId, 'rec-1');
    assert.equal(results[0].filePath, client.recordingFilePath);
});

test('rtpbridge recording.stopped event removes the tracked recording and records its metadata', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.startRecording('media-session-1', {});
    client.stopRecording = async () => {
        throw new Error('stop must not be called for an already-stopped recording');
    };
    client.emit('recording.stopped', {
        recordingId: 'rec-1',
        filePath: client.recordingFilePath,
        durationMs: 42,
        packets: 7,
        reason: 'endpoint_removed'
    });
    const results = await service.prepareHandoff('media-session-1', 'owner', {});
    assert.equal(results.length, 1);
    assert.equal(results[0].recordingId, 'rec-1');
    assert.equal(results[0].durationMs, 42);
});

test('a late recording-stop reply for a destroyed session does not recreate handoff history', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    await service.startRecording('media-session-1', {});
    const pending = Promise.withResolvers<void>();
    const original = client.stopRecording.bind(client);
    client.stopRecording = async (...args: Parameters<typeof original>) => {
        await pending.promise;
        return original(...args);
    };
    const stop = service.stopRecording('rec-1');
    const destruction = service.destroySessionsForOwner('owner');
    pending.resolve();
    await stop;
    await destruction;
    assert.equal((service as any).handoffRecordings.has('media-session-1'), false);
});

test('finalized handoff recordings are capped at 256, dropping the oldest', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    let n = 0;
    client.startRecording = async (_sessionId, params) => {
        client.recordingFilePath = params.filePath;
        return { recordingId: `rec-${++n}` };
    };
    for (let i = 1; i <= 257; i++) {
        await service.startRecording('media-session-1', { filePath: `r${i}.pcap` });
        await service.stopRecording(`rec-${i}`);
    }
    const recordings = await service.prepareHandoff('media-session-1', 'owner', {});
    assert.equal(recordings.length, 256);
    assert.equal(recordings[0].recordingId, 'rec-2');
    assert.equal(recordings.at(-1)!.recordingId, 'rec-257');
});

test('a timed-out recording.start is reconciled at handoff by stopping unknown active recordings', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    client.startRecording = async () => {
        client.sessionRecordings = [{ recordingId: 'ghost-1', filePath: 'ghost.pcap', state: 'active' }];
        throw new RtpbridgeTimeoutError('recording.start');
    };
    await assert.rejects(service.startRecording('media-session-1', {}), RtpbridgeTimeoutError);
    const stopped: string[] = [];
    client.stopRecording = async (recordingId?: string) => {
        stopped.push(recordingId!);
        return { filePath: 'ghost.pcap', durationMs: 1, packets: 1 };
    };
    const results = await service.prepareHandoff('media-session-1', 'owner', {});
    assert.deepEqual(stopped, ['ghost-1']);
    assert.equal(results[0].recordingId, 'ghost-1');
    // The mark is cleared: a later handoff does not query again.
    client.listSessionRecordings = async () => {
        throw new Error('should not be called');
    };
    await service.prepareHandoff('media-session-1', 'owner', {});
});

test('handoff fails closed when recording state cannot be verified after a timed-out start', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    client.startRecording = async () => {
        throw new RtpbridgeTimeoutError('recording.start');
    };
    await assert.rejects(service.startRecording('media-session-1', {}), RtpbridgeTimeoutError);
    client.listSessionRecordings = async () => {
        throw new Error('info unavailable');
    };
    await assert.rejects(service.prepareHandoff('media-session-1', 'owner', {}), MediaActionConflictError);
    // Guard released on failure, mark retained: a retry still verifies.
    client.listSessionRecordings = async () => [];
    await service.prepareHandoff('media-session-1', 'owner', {});
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
    private transport = new RtpbridgeTransport();
    backendHttpUrl = 'http://127.0.0.1:9';

    constructor(
        private clients: FakeRtpbridgeClient[] | FakeRtpbridgeClient,
        ...rest: FakeRtpbridgeClient[]
    ) {
        if (!Array.isArray(clients)) this.clients = [clients, ...rest];
    }

    async createClient() {
        return (this.clients as FakeRtpbridgeClient[])[this.index++];
    }

    async resolveBackend(backendId: string) {
        return { id: backendId, url: `ws://${backendId}:9100`, httpUrl: this.backendHttpUrl };
    }

    async resolveBackends() {
        const backend = await this.resolveBackend('rtpbridge-0');
        return [backend];
    }

    getHttpRequestOptions(method: string, url: string) {
        return this.transport.httpOptions(method, url);
    }

    unregisterCall() {}
}

class FakeRtpbridgeClient extends EventEmitter {
    backendId: string;
    iceUrls?: string[];
    destroyedSessions: string[] = [];
    iceRestartCalls = 0;
    recordingFilePath = '/var/lib/rtpbridge/recordings/call_42.pcap';
    startRecordingPaths: string[] = [];
    removedEndpoints: string[] = [];
    startedVad: Array<{ endpointId: string; options: unknown }> = [];
    stoppedVad: string[] = [];
    injectedDtmf: Array<{ endpointId: string; digit: string }> = [];
    sensitiveDtmfChanges: Array<{ endpointId: string; enabled: boolean }> = [];
    sensitiveDtmfError?: Error;
    sensitiveDtmfDisableError?: Error;
    sensitiveDtmfDelay?: Promise<void>;
    updatedDirections: Array<{ endpointId: string; direction: string }> = [];
    bridgedSessions: Array<{ targetSessionId: string; direction?: string }> = [];
    bridgeSessionDelay?: Promise<void>;
    bridgeSessionStarted?: () => void;
    fileSources: string[] = [];

    constructor(
        private sessionId = 'media-session-1',
        backendId = 'rtpbridge-0',
        private mediaIp: string | string[] = ['108.85.76.234']
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

    async setSensitiveDtmf(endpointId: string, enabled: boolean) {
        this.sensitiveDtmfChanges.push({ endpointId, enabled });
        if (enabled && this.sensitiveDtmfError) throw this.sensitiveDtmfError;
        if (enabled) await this.sensitiveDtmfDelay;
        if (!enabled && this.sensitiveDtmfDisableError) throw this.sensitiveDtmfDisableError;
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

    async stopRecording(_recordingId?: string) {
        return { filePath: this.recordingFilePath, durationMs: 1000, packets: 10 };
    }

    sessionRecordings: Array<{ recordingId: string; filePath: string; state: 'active' | 'stopped' }> = [];
    async listSessionRecordings() {
        return this.sessionRecordings;
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

test('explicit TURN URLs use configured certificates and backend URLs override the global default', async () => {
    const client = new FakeRtpbridgeClient('external-turn', 'rtpbridge-0', ['2001:db8::1']);
    client.iceUrls = ['stun:stun.example.net:3478', 'turns:turn.backend.example.net:443?transport=tcp'];
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', undefined, 1000, {
        authSecret: 'turn-secret',
        credentialTtlSeconds: 3600,
        urls: ['turns:global.example.net:443?transport=tcp']
    });
    const session = await service.createSession({ ownerConnectionId: 'conn-1' });
    assert.deepEqual(session.iceConfiguration?.servers[0], { urls: ['stun:stun.example.net:3478'] });
    assert.deepEqual(session.iceConfiguration?.servers[1].urls, ['turns:turn.backend.example.net:443?transport=tcp']);
    const turn = session.iceConfiguration!.servers[1];
    assert.equal(turn.credential, createHmac('sha1', 'turn-secret').update(turn.username!).digest('base64'));
    await service.destroySession(session.sessionId);
});

test('explicit STUN URLs work without a TURN secret or advertised IPv4 address', async () => {
    const client = new FakeRtpbridgeClient('external-stun', 'rtpbridge-0', ['2001:db8::1']);
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any, '/recordings', undefined, 1000, {
        credentialTtlSeconds: 3600,
        urls: ['stun:stun.example.net:3478']
    });
    const session = await service.createSession({ ownerConnectionId: 'conn-1' });
    assert.deepEqual(session.iceConfiguration?.servers, [{ urls: ['stun:stun.example.net:3478'] }]);
    await service.destroySession(session.sessionId);
});

test('a held handoff guard refuses RTP, WebRTC and bridge endpoint additions until released', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    const token = {};
    await service.prepareHandoff('media-session-1', 'owner', token);
    await assert.rejects(service.createRtpOffer('media-session-1'), MediaActionConflictError);
    await assert.rejects(service.createRtpFromOffer('media-session-1', { sdp: 'v=0' }), MediaActionConflictError);
    await assert.rejects(service.createWebrtcOffer('media-session-1'), MediaActionConflictError);
    assert.equal(service.get('media-session-1')?.endpoints.filter(endpoint => endpoint.type === 'rtp').length, 1);
    service.releaseHandoff('media-session-1', token);
    await service.createRtpOffer('media-session-1');
});

test('handoff preparation is refused while an endpoint creation is in flight', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = client.createRtpOffer.bind(client);
    client.createRtpOffer = async (...args: Parameters<typeof original>) => {
        started.resolve();
        await release.promise;
        return original(...args);
    };
    const creating = service.createRtpOffer('media-session-1');
    await started.promise;
    await assert.rejects(service.prepareHandoff('media-session-1', 'owner', {}), MediaActionConflictError);
    release.resolve();
    await creating;
    // The refused attempt left no guard behind (recording still starts) and the counter drained.
    await service.startRecording('media-session-1', {});
    const token = {};
    await service.prepareHandoff('media-session-1', 'owner', token);
    service.releaseHandoff('media-session-1', token);
});

test('a failed endpoint creation releases its in-flight count so a later handoff can proceed', async () => {
    const client = new FakeRtpbridgeClient();
    const service = new MediaSessionService(new FakeMediaServerManager(client) as any);
    await service.createSession({ ownerConnectionId: 'owner' });
    await service.createRtpOffer('media-session-1');
    const original = client.createRtpOffer.bind(client);
    client.createRtpOffer = async () => {
        throw new Error('backend refused');
    };
    await assert.rejects(service.createRtpOffer('media-session-1'), /backend refused/);
    client.createRtpOffer = original;
    const token = {};
    await service.prepareHandoff('media-session-1', 'owner', token);
    service.releaseHandoff('media-session-1', token);
});
