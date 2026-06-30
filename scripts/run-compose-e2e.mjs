#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import WebSocket from 'ws';

const composeFile = 'docker-compose.e2e.yml';
const projectName = process.env.COMPOSE_PROJECT_NAME || `rtc-session-gateway-e2e-${process.pid}`;
const gatewayBaseUrl = process.env.E2E_GATEWAY_URL || 'http://127.0.0.1:3001';
const controlUrl = process.env.E2E_CONTROL_URL || 'ws://127.0.0.1:3001/control';
const drachtioHost = process.env.E2E_SIP_HOST || '127.0.0.1';
const drachtioPort = Number(process.env.E2E_SIP_PORT || 5060);
const rtpbridgeMediaHost = process.env.E2E_RTPBRIDGE_MEDIA_HOST;
const rtpbridgeHttpUrls = (process.env.E2E_RTPBRIDGE_URLS || 'http://127.0.0.1:9100,http://127.0.0.1:9101')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
const inContainerRtpbridgeHttpUrls = process.env.E2E_CONTAINER_RTPBRIDGE_URLS || 'http://rtpbridge:9100,http://rtpbridge-b:9100';
const PCAP_HEADER_BYTES = 24;

const steps = [];
let control;

async function main() {
    const env = {
        ...process.env,
        COMPOSE_PROJECT_NAME: projectName,
        RTPBRIDGE_IMAGE: process.env.RTPBRIDGE_IMAGE || pickRtpbridgeImage()
    };

    step(`Using compose project ${projectName}`);
    step(`Using rtpbridge image ${env.RTPBRIDGE_IMAGE}`);

    run('docker', ['compose', '-f', composeFile, 'up', '-d', '--build', '--remove-orphans'], { env });
    await waitForHttp(`${gatewayBaseUrl}/healthz`, body => body?.ok === true, 60_000);
    for (const url of rtpbridgeHttpUrls) {
        await waitForHttp(`${url}/health`, body => body?.status === 'ok', 60_000);
    }

    control = await connectControl(controlUrl);
    await control.request('route.register', { routes: [{ match: 'exact', value: 'e2e' }] });

    await runRejectScenario(control);
    await runAnswerAndHangupScenario(control);
    await runOutboundSipScenario(control);
    await runMultiBackendScenario();
    await runMediaScenario();
    await runWebrtcScenario();
    await runOutboundBridgeScenario();
    await runRecordingScenario();
    await runMediaActionsScenario();

    step('E2E complete');
}

main()
    .then(async () => {
        await closeControl();
        await cleanup(0);
    })
    .catch(async err => {
        console.error(`\nE2E failed: ${err?.stack || err}`);
        await dumpComposeLogs();
        await closeControl();
        await cleanup(1);
    });

async function runRejectScenario(controlClient) {
    step('Running inbound INVITE rejection scenario');
    const sip = await SipTcpClient.create();
    try {
        const invite = sip.buildInvite({ user: 'e2e' });
        const inviteRequest = controlClient.waitForRequest('sip.invite', 10_000);
        sip.send(invite.message);
        const request = await inviteRequest;
        assertEqual(request.params.destinationUser, 'e2e', 'sip.invite destinationUser');
        assert(request.params.sdp?.includes('m=audio'), 'sip.invite should include remote SDP');
        controlClient.respond(request.id, {
            action: 'reject',
            status: 486,
            reason: 'Busy Here'
        });

        const finalResponse = await sip.waitForFinalResponse(invite.callId, 10_000);
        assertEqual(finalResponse.status, 486, 'reject final SIP status');
        const calls = await getJson(`${gatewayBaseUrl}/calls`);
        assertEqual(calls.calls.length, 0, 'rejected INVITE should not create active calls');
        const sessions = await getJson(`${gatewayBaseUrl}/sessions`);
        assertEqual(sessions.sessions.length, 0, 'rejected INVITE should not create gateway sessions');
        await assertRtpbridgeSessionsEmpty('rejected INVITE should not allocate rtpbridge sessions');
    } finally {
        sip.close();
    }
}

async function runAnswerAndHangupScenario(controlClient) {
    step('Running inbound INVITE answer and gateway hangup scenario');
    const sip = await SipTcpClient.create();
    try {
        const invite = sip.buildInvite({ user: 'e2e' });
        const inviteRequest = controlClient.waitForRequest('sip.invite', 10_000);
        const answeredEvent = controlClient.waitForEvent('sip.answered', 10_000);

        sip.send(invite.message);
        const request = await inviteRequest;
        controlClient.respond(request.id, {
            action: 'answer',
            status: 200,
            sdp: localSdp(41000)
        });

        const finalResponse = await sip.waitForFinalResponse(invite.callId, 10_000);
        assertEqual(finalResponse.status, 200, 'answer final SIP status');
        assert(finalResponse.body.includes('m=audio'), '200 OK should include local SDP');
        sip.send(sip.buildAck(invite, finalResponse));

        const answered = await answeredEvent;
        const sessionId = answered.sessionId;
        assert(sessionId, 'sip.answered should include sessionId');

        const call = await getJson(`${gatewayBaseUrl}/calls/${encodeURIComponent(sessionId)}`);
        assertEqual(call.callId, sessionId, 'answered call should be queryable');
        assertEqual(call.controlConnectionId, controlClient.connectionId, 'answered call should be owned by control connection');

        const byeRequest = sip.waitForRequest('BYE', invite.callId, 10_000);
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, { reason: 'e2e-complete' });
        const bye = await byeRequest;
        sip.send(sip.buildResponse(bye, 200, 'OK'));

        await eventually(async () => {
            const calls = await getJson(`${gatewayBaseUrl}/calls`);
            assertEqual(calls.calls.length, 0, 'gateway hangup should clear active calls');
        }, 10_000);
    } finally {
        sip.close();
    }
}

async function runOutboundSipScenario(controlClient) {
    step('Running outbound SIP origination scenario');
    const responder = await SipResponderClient.start();
    let sessionId;
    try {
        const invitePromise = responder.waitForEvent('invite', 10_000);
        const outbound = await controlClient.request('sip.createOutbound', {
            requestUri: `sip:e2e@gateway:${responder.port};transport=tcp`,
            sdp: localSdp(42000),
            headers: {
                From: '"E2E Agent" <sip:agent@rtc-session-gateway-e2e>',
                'X-E2E': 'outbound'
            },
            callingNumber: '18005551212',
            callingName: 'Zyno E2E'
        }, 15_000);
        sessionId = outbound.sessionId;
        assert(sessionId, 'outbound SIP should return sessionId');
        assert(outbound.sdp?.includes('m=audio'), 'outbound SIP should return remote SDP answer');

        const invite = await invitePromise;
        assert(invite.body?.includes('m=audio'), 'outbound INVITE should include local SDP offer');
        assertEqual(invite.headers['x-e2e'], 'outbound', 'outbound INVITE should include custom headers');
        await responder.waitForEvent('ack', 10_000);

        const call = await getJson(`${gatewayBaseUrl}/calls/${encodeURIComponent(sessionId)}`);
        assertEqual(call.callId, sessionId, 'outbound call should be queryable');
        assertEqual(call.controlConnectionId, controlClient.connectionId, 'outbound call should be owned by control connection');

        const terminatedEvent = controlClient.waitForEvent('sip.terminated', 10_000, event => event.sessionId === sessionId);
        const byePromise = responder.waitForEvent('bye', 10_000);
        await controlClient.request('session.delete', { sessionId, reason: 'e2e-outbound-complete' });
        await byePromise;
        const terminated = await terminatedEvent;
        assertEqual(terminated.sessionId, sessionId, 'outbound BYE should emit sip.terminated for the session');

        await eventually(async () => {
            const calls = await getJson(`${gatewayBaseUrl}/calls`);
            assertEqual(calls.calls.length, 0, 'outbound BYE should clear active calls');
        }, 10_000);
    } finally {
        await responder.close();
    }
}

async function runMultiBackendScenario() {
    step('Running rtpbridge multi-backend selection scenario');
    const first = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-multibackend-a' });
    const second = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-multibackend-b' });
    const pinned = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-multibackend-a' });
    try {
        assert(first.backendId, 'first multi-backend session should return backendId');
        assert(second.backendId, 'second multi-backend session should return backendId');
        assert(pinned.backendId, 'pinned multi-backend session should return backendId');
        assert(first.backendId !== second.backendId, `distinct calls should round-robin across rtpbridge backends: ${first.backendId}`);
        assertEqual(pinned.backendId, first.backendId, 'same callId should pin to the first selected backend');
    } finally {
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(first.sessionId)}`, {}).catch(() => undefined);
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(second.sessionId)}`, {}).catch(() => undefined);
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(pinned.sessionId)}`, {}).catch(() => undefined);
        await assertRtpbridgeSessionsEmpty('multi-backend cleanup should remove rtpbridge sessions');
    }
}

async function runMediaScenario() {
    step('Running rtpbridge media session scenario');
    const probe = await RtpProbeClient.start();
    const first = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-media-call' });
    const second = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-media-call' });
    const sessionId = first.sessionId;
    const targetSessionId = second.sessionId;
    assert(sessionId, 'session.create should return sessionId');
    assert(targetSessionId, 'second session.create should return sessionId');
    assert(first.backendId, 'session.create should return backendId');
    assertEqual(first.backendId, second.backendId, 'same callId should pin sessions to one rtpbridge backend');

    let sourceOffer;
    let targetOffer;
    let peerA;
    let peerB;
    try {
        peerA = await probe.createPeer();
        peerB = await probe.createPeer();
        sourceOffer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/rtp/offers`, {
            direction: 'sendrecv',
            codecs: ['PCMU']
        });
        targetOffer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(targetSessionId)}/rtp/offers`, {
            direction: 'sendrecv',
            codecs: ['PCMU']
        });
        assert(sourceOffer.endpointId, 'source rtp.createOffer should return endpointId');
        assert(sourceOffer.sdpOffer?.includes('m=audio'), 'source rtp.createOffer should return SDP offer');
        assert(targetOffer.endpointId, 'target rtp.createOffer should return endpointId');
        assert(targetOffer.sdpOffer?.includes('m=audio'), 'target rtp.createOffer should return SDP offer');

        await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(sourceOffer.endpointId)}/rtp/answer`, {
            sdp: rtpAnswer(peerA.ip, peerA.port)
        });
        await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(targetOffer.endpointId)}/rtp/answer`, {
            sdp: rtpAnswer(peerB.ip, peerB.port)
        });

        const bridge = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/bridge`, {
            targetSessionId,
            direction: 'sendrecv'
        });
        assertEqual(bridge.sessionId, sessionId, 'media.bridge should return source sessionId');
        assert(bridge.endpointId, 'media.bridge should return source bridge endpointId');
        assertEqual(bridge.targetSessionId, targetSessionId, 'media.bridge should return target sessionId');
        assert(bridge.targetEndpointId, 'media.bridge should return target bridge endpointId');

        const bridgedSource = await getJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`);
        const bridgedTarget = await getJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(targetSessionId)}`);
        assert(
            bridgedSource.endpoints.some(endpoint => endpoint.endpointId === bridge.endpointId && endpoint.type === 'bridge'),
            'source session should expose tracked bridge endpoint'
        );
        assert(
            bridgedTarget.endpoints.some(endpoint => endpoint.endpointId === bridge.targetEndpointId && endpoint.type === 'bridge'),
            'target session should expose tracked bridge endpoint'
        );

        const sourceRtpTarget = parseRtpTarget(sourceOffer.sdpOffer, rtpbridgeMediaHost);
        const targetRtpTarget = parseRtpTarget(targetOffer.sdpOffer, rtpbridgeMediaHost);
        await probe.sendPackets(peerB.peerId, targetRtpTarget, 3);
        const packetFromBridge = probe.waitForPacket(peerB.peerId, 10_000);
        await probe.sendPackets(peerA.peerId, sourceRtpTarget, 80);
        const received = await packetFromBridge;
        assert(received.length >= 12, 'bridged RTP packet should include an RTP header');
        assertEqual(received.payloadType, 0, 'bridged RTP packet should preserve PCMU payload type');

        await postJson(`${gatewayBaseUrl}/media/bridges/${encodeURIComponent(bridge.endpointId)}/unbridge`, {});
        const unbridgedSource = await getJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`);
        const unbridgedTarget = await getJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(targetSessionId)}`);
        assert(
            !unbridgedSource.endpoints.some(endpoint => endpoint.type === 'bridge'),
            'source session should remove bridge endpoint after unbridge'
        );
        assert(
            !unbridgedTarget.endpoints.some(endpoint => endpoint.type === 'bridge'),
            'target session should remove paired bridge endpoint after unbridge'
        );
    } finally {
        if (peerA?.peerId) await probe.closePeer(peerA.peerId).catch(() => undefined);
        if (peerB?.peerId) await probe.closePeer(peerB.peerId).catch(() => undefined);
        await probe.close();
        if (sourceOffer?.endpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(sourceOffer.endpointId)}`, {}).catch(() => undefined);
        if (targetOffer?.endpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(targetOffer.endpointId)}`, {}).catch(() => undefined);
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, {}).catch(() => undefined);
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(targetSessionId)}`, {}).catch(() => undefined);
    }
    await assertRtpbridgeSessionsEmpty('media session delete should remove rtpbridge sessions');
}

async function runWebrtcScenario() {
    step('Running WebRTC media session scenario');
    run('docker', [
        'compose', '-f', composeFile, 'exec', '-T',
        '-e', `E2E_RTPBRIDGE_URLS=${inContainerRtpbridgeHttpUrls}`,
        'gateway', 'node', 'scripts/webrtc-probe.mjs'
    ], {
        env: {
            ...process.env,
            COMPOSE_PROJECT_NAME: projectName
        }
    });
}

async function runOutboundBridgeScenario() {
    step('Running outbound SIP to WebRTC bridge scenario');
    run('docker', [
        'compose', '-f', composeFile, 'exec', '-T',
        '-e', `E2E_RTPBRIDGE_URLS=${inContainerRtpbridgeHttpUrls}`,
        'gateway', 'node', 'scripts/outbound-bridge-probe.mjs'
    ], {
        env: {
            ...process.env,
            COMPOSE_PROJECT_NAME: projectName
        }
    });
}

async function runRecordingScenario() {
    step('Running recording continuity scenario');
    const probe = await RtpProbeClient.start();
    const session = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-recording-call' });
    const sessionId = session.sessionId;
    let peer;
    let offer;
    const stoppedRecordings = [];
    try {
        peer = await probe.createPeer();
        offer = await createAnsweredRtpEndpoint(sessionId, peer);
        const rtpTarget = parseRtpTarget(offer.sdpOffer, rtpbridgeMediaHost);

        await probe.sendPackets(peer.peerId, rtpTarget, 5);
        const first = await recordSegment(sessionId, offer.endpointId, 'e2e-recording-seg-1.pcap', peer.peerId, rtpTarget, probe);
        const second = await recordSegment(sessionId, offer.endpointId, 'e2e-recording-seg-2.pcap', peer.peerId, rtpTarget, probe);
        stoppedRecordings.push(first, second);

        const listed = await getJson(`${gatewayBaseUrl}/recordings?startsWith=e2e-recording-`);
        const listedPaths = listed.recordings.map(recording => recording.path).sort();
        assert(listedPaths.includes(first.recordingPath), 'recording list should include first real PCAP');
        assert(listedPaths.includes(second.recordingPath), 'recording list should include second real PCAP');

        const firstBytes = await getBinary(`${gatewayBaseUrl}${first.downloadPath}`);
        const secondBytes = await getBinary(`${gatewayBaseUrl}${second.downloadPath}`);
        assertPcap(firstBytes, 'first recording download');
        assertPcap(secondBytes, 'second recording download');

        const merged = await postBinary(`${gatewayBaseUrl}/recordings/merge`, {
            targets: stoppedRecordings.map(recording => ({
                backendId: recording.backendId,
                path: recording.recordingPath
            }))
        });
        assert(merged.contentType.includes('application/vnd.tcpdump.pcap'), 'recording merge should return PCAP content type');
        assertPcap(merged.body, 'merged recording');
        assertEqual(
            merged.body.length,
            firstBytes.length + secondBytes.length - PCAP_HEADER_BYTES,
            'merged recording should contain one global header plus both segment bodies'
        );
    } finally {
        for (const recording of stoppedRecordings) {
            await deleteJson(`${gatewayBaseUrl}/recordings/${encodeURIComponent(recording.backendId)}/${encodeRecordingPath(recording.recordingPath)}`, {}).catch(() => undefined);
        }
        if (peer?.peerId) await probe.closePeer(peer.peerId).catch(() => undefined);
        await probe.close();
        if (offer?.endpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(offer.endpointId)}`, {}).catch(() => undefined);
        if (sessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, {}).catch(() => undefined);
    }
    await assertRtpbridgeSessionsEmpty('recording scenario cleanup should remove rtpbridge sessions');
}

async function runMediaActionsScenario() {
    step('Running local media action scenario');
    const probe = await RtpProbeClient.start();
    const audio = await probe.startAudioServer();
    const session = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-media-actions-call' });
    const sessionId = session.sessionId;
    let peer;
    let offer;
    try {
        peer = await probe.createPeer();
        offer = await createAnsweredRtpEndpoint(sessionId, peer);
        const rtpTarget = parseRtpTarget(offer.sdpOffer, rtpbridgeMediaHost);
        await probe.sendPackets(peer.peerId, rtpTarget, 5);

        const gatherPromise = postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/gather`, {
            endpointId: offer.endpointId,
            numDigits: 2,
            timeoutMs: 5_000,
            interDigitTimeoutMs: 1_000,
            terminator: '#'
        });
        await sendDtmfSequenceUntilSettled(gatherPromise, probe, peer.peerId, rtpTarget, ['4', '4']);
        assertDeepEqual(await gatherPromise, { digits: '44', reason: 'digits' }, 'media.gather should collect DTMF from RTP');

        const playAndGatherPromise = postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/play-and-gather`, {
            endpointId: offer.endpointId,
            source: audio.url,
            numDigits: 1,
            timeoutMs: 5_000,
            interDigitTimeoutMs: 1_000
        });
        await sendDtmfSequenceUntilSettled(playAndGatherPromise, probe, peer.peerId, rtpTarget, ['7'], { intervalMs: 250 });
        const playAndGather = await playAndGatherPromise;
        assertEqual(playAndGather.digits, '7', 'media.playAndGather should collect a digit');
        assertEqual(playAndGather.reason, 'digits', 'media.playAndGather should complete by digit count');
        assert(playAndGather.playbackEndpointId, 'media.playAndGather should return playback endpoint id');

        const leaveMessagePromise = postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/leave-message`, {
            endpointId: offer.endpointId,
            messageSource: audio.messageUrl,
            maxWaitMs: 8_000,
            silenceIntervalMs: 300,
            playbackTimeoutMs: 8_000
        });
        await sendVadPatternUntilSettled(leaveMessagePromise, probe, peer.peerId, rtpTarget);
        assertDeepEqual(await leaveMessagePromise, { terminator: 'silence', messagePlayed: true }, 'media.leaveMessage should wait for VAD silence and play message');
    } finally {
        if (peer?.peerId) await probe.closePeer(peer.peerId).catch(() => undefined);
        await probe.closeAudioServer().catch(() => undefined);
        await probe.close();
        if (offer?.endpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(offer.endpointId)}`, {}).catch(() => undefined);
        if (sessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, {}).catch(() => undefined);
    }
    await assertRtpbridgeSessionsEmpty('media action cleanup should remove rtpbridge sessions');
}

async function createAnsweredRtpEndpoint(sessionId, peer) {
    const offer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/rtp/offers`, {
        direction: 'sendrecv',
        codecs: ['PCMU']
    });
    assert(offer.endpointId, 'rtp.createOffer should return endpointId');
    assert(offer.sdpOffer?.includes('m=audio'), 'rtp.createOffer should return SDP offer');
    await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(offer.endpointId)}/rtp/answer`, {
        sdp: rtpAnswer(peer.ip, peer.port)
    });
    return offer;
}

async function recordSegment(sessionId, endpointId, filePath, peerId, rtpTarget, probe) {
    const started = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/recordings`, {
        endpointId,
        filePath
    });
    assert(started.recordingId, 'recording.start should return recordingId');
    await probe.sendPackets(peerId, rtpTarget, 50);
    const stopped = await postJson(`${gatewayBaseUrl}/recordings/${encodeURIComponent(started.recordingId)}/stop`, {});
    assert(stopped.packets > 0, 'recording.stop should report captured packets');
    assertEqual(stopped.recordingPath, filePath, 'recording.stop should preserve requested path');
    assert(stopped.downloadPath, 'recording.stop should include gateway download path');
    return stopped;
}

function sessionListLength(body) {
    if (Array.isArray(body)) return body.length;
    if (Array.isArray(body?.sessions)) return body.sessions.length;
    return 0;
}

async function assertRtpbridgeSessionsEmpty(message) {
    await eventually(async () => {
        for (const url of rtpbridgeHttpUrls) {
            const bridgeSessions = await getJson(`${url}/sessions`);
            assertEqual(sessionListLength(bridgeSessions), 0, `${message} (${url})`);
        }
    }, 10_000);
}

function observeSettlement(promise) {
    const state = { settled: false };
    promise.then(
        () => {
            state.settled = true;
        },
        () => {
            state.settled = true;
        }
    );
    return state;
}

async function sendDtmfSequenceUntilSettled(actionPromise, probe, peerId, rtpTarget, digits, options = {}) {
    const state = observeSettlement(actionPromise);
    const deadline = Date.now() + (options.maxMs ?? 4_500);
    const intervalMs = options.intervalMs ?? 150;
    while (!state.settled && Date.now() < deadline) {
        for (const digit of digits) {
            if (state.settled) return;
            await probe.sendDtmf(peerId, rtpTarget, digit);
        }
        if (!state.settled) await sleep(intervalMs);
    }
}

async function sendVadPatternUntilSettled(actionPromise, probe, peerId, rtpTarget, options = {}) {
    const state = observeSettlement(actionPromise);
    const deadline = Date.now() + (options.maxMs ?? 7_000);
    while (!state.settled && Date.now() < deadline) {
        await probe.sendPackets(peerId, rtpTarget, options.noisePackets ?? 25, { payloadMode: 'noise' });
        if (state.settled) return;
        await probe.sendPackets(peerId, rtpTarget, options.silencePackets ?? 80, { payloadMode: 'silence' });
    }
}

function pickRtpbridgeImage() {
    const candidates = [
        'ghcr.io/zyno-io/rtpbridge:latest'
    ];
    for (const candidate of candidates) {
        if (dockerImageExists(candidate)) return candidate;
    }

    const localCheckout = process.env.RTPBRIDGE_LOCAL_CHECKOUT;
    if (localCheckout && existsSync(`${localCheckout}/Dockerfile`)) {
        const tag = 'rtc-session-gateway-rtpbridge-e2e:local';
        step(`Building local rtpbridge image from ${localCheckout}`);
        run('docker', ['build', '-t', tag, localCheckout]);
        return tag;
    }

    return candidates[0];
}

function dockerImageExists(image) {
    const result = spawnSync('docker', ['image', 'inspect', image], {
        stdio: 'ignore'
    });
    return result.status === 0;
}

function run(command, args, options = {}) {
    const display = `${command} ${args.join(' ')}`;
    step(display);
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        cwd: new URL('..', import.meta.url),
        ...options
    });
    if (result.status !== 0) {
        throw new Error(`${display} exited with ${result.status}`);
    }
}

function step(message) {
    steps.push(message);
    console.log(`\n[compose-e2e] ${message}`);
}

async function cleanup(exitCode) {
    if (process.env.KEEP_E2E_STACK === '1') {
        process.exit(exitCode);
        return;
    }

    const env = { ...process.env, COMPOSE_PROJECT_NAME: projectName };
    const result = spawnSync('docker', ['compose', '-f', composeFile, 'down', '-v', '--remove-orphans'], {
        cwd: new URL('..', import.meta.url),
        env,
        stdio: 'inherit'
    });
    process.exit(exitCode || result.status || 0);
}

async function dumpComposeLogs() {
    try {
        execFileSync('docker', ['compose', '-f', composeFile, 'ps', '-a'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
            stdio: 'inherit'
        });
        execFileSync('docker', ['compose', '-f', composeFile, 'logs', '--no-color', '--tail=240'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
            stdio: 'inherit'
        });
    } catch {
        // Best-effort diagnostics only.
    }
}

async function closeControl() {
    if (!control) return;
    await control.close();
    control = undefined;
}

async function waitForHttp(url, predicate, timeoutMs) {
    await eventually(async () => {
        const body = await getJson(url);
        assert(predicate(body), `${url} did not satisfy readiness predicate`);
    }, timeoutMs);
}

async function eventually(fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            await sleep(500);
        }
    }
    throw lastError || new Error(`condition not met within ${timeoutMs}ms`);
}

async function getJson(url) {
    const response = await fetch(url);
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
    return body;
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${text}`);
    return parsed;
}

async function deleteJson(url, body) {
    const response = await fetch(url, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`DELETE ${url} failed with ${response.status}: ${text}`);
    return parsed;
}

async function getBinary(url) {
    const response = await fetch(url);
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${body.toString('utf8')}`);
    return body;
}

async function postBinary(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}: ${buffer.toString('utf8')}`);
    return {
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        body: buffer
    };
}

async function connectControl(url) {
    const ws = new WebSocket(url);
    const pending = new Map();
    const requestWaiters = [];
    const eventWaiters = [];
    const bufferedRequests = [];
    const bufferedEvents = [];
    let connectionId;

    ws.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.type === 'response') {
            const waiter = pending.get(message.id);
            if (!waiter) return;
            pending.delete(message.id);
            clearTimeout(waiter.timer);
            if (message.ok) waiter.resolve(message.result);
            else waiter.reject(new Error(`${message.error?.code || 'ERROR'}: ${message.error?.message || 'request failed'}`));
            return;
        }

        if (message.type === 'request') {
            const index = requestWaiters.findIndex(waiter => waiter.method === message.method);
            if (index >= 0) {
                const [waiter] = requestWaiters.splice(index, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
            } else {
                bufferedRequests.push(message);
            }
            return;
        }

        if (message.type === 'event') {
            if (message.event === 'control.connected') {
                connectionId = message.data?.connectionId;
            }
            const index = eventWaiters.findIndex(waiter => matchesControlEvent(message, waiter.event, waiter.predicate));
            if (index >= 0) {
                const [waiter] = eventWaiters.splice(index, 1);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
            } else {
                bufferedEvents.push(message);
            }
        }
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`control WebSocket connect timeout: ${url}`)), 10_000);
        ws.once('open', () => {
            clearTimeout(timer);
            resolve();
        });
        ws.once('error', reject);
    });

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('control.connected event timeout')), 10_000);
        const check = () => {
            if (connectionId) {
                clearTimeout(timer);
                resolve();
            } else {
                setTimeout(check, 50);
            }
        };
        check();
    });

    return {
        get connectionId() {
            return connectionId;
        },
        request(method, params, timeoutMs = 10_000) {
            const id = randomUUID();
            const payload = JSON.stringify({ type: 'request', id, method, params });
            const promise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`control request timeout: ${method}`));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
            });
            ws.send(payload);
            return promise;
        },
        respond(id, result) {
            ws.send(JSON.stringify({ type: 'response', id, ok: true, result }));
        },
        waitForRequest(method, timeoutMs) {
            const bufferedIndex = bufferedRequests.findIndex(message => message.method === method);
            if (bufferedIndex >= 0) {
                const [message] = bufferedRequests.splice(bufferedIndex, 1);
                return Promise.resolve(message);
            }
            return new Promise((resolve, reject) => {
                const waiter = {
                    method,
                    resolve,
                    reject,
                    timer: setTimeout(() => {
                        removeWaiter(requestWaiters, waiter);
                        reject(new Error(`timed out waiting for control request ${method}`));
                    }, timeoutMs)
                };
                requestWaiters.push(waiter);
            });
        },
        waitForEvent(event, timeoutMs, predicate = () => true) {
            const bufferedIndex = bufferedEvents.findIndex(message => matchesControlEvent(message, event, predicate));
            if (bufferedIndex >= 0) {
                const [message] = bufferedEvents.splice(bufferedIndex, 1);
                return Promise.resolve(message);
            }
            return new Promise((resolve, reject) => {
                const waiter = {
                    event,
                    predicate,
                    resolve,
                    reject,
                    timer: setTimeout(() => {
                        removeWaiter(eventWaiters, waiter);
                        reject(new Error(`timed out waiting for control event ${event}`));
                    }, timeoutMs)
                };
                eventWaiters.push(waiter);
            });
        },
        close() {
            return new Promise(resolve => {
                if (ws.readyState === WebSocket.CLOSED) {
                    resolve();
                    return;
                }
                ws.once('close', resolve);
                ws.close();
                setTimeout(resolve, 500);
            });
        }
    };
}

function removeWaiter(waiters, waiter) {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
}

function matchesControlEvent(message, event, predicate) {
    return message.event === event && predicate(message);
}

class RtpProbeClient {
    constructor(child) {
        this.child = child;
        this.pending = new Map();
        this.buffer = '';
        this.closed = false;
        child.stdout.on('data', data => this.receive(data.toString()));
        child.stderr.on('data', data => {
            const text = data.toString();
            if (text.trim()) process.stderr.write(`[rtp-probe] ${text}`);
        });
        child.on('close', code => {
            this.closed = true;
            const err = new Error(`RTP probe exited with ${code}`);
            for (const [id, pending] of this.pending) {
                clearTimeout(pending.timer);
                pending.reject(err);
                this.pending.delete(id);
            }
        });
    }

    static async start() {
        const child = spawn('docker', ['compose', '-f', composeFile, 'exec', '-T', 'gateway', 'node', 'scripts/rtp-probe.mjs'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const client = new RtpProbeClient(child);
        await client.request('ping', {}, 10_000);
        return client;
    }

    createPeer() {
        return this.request('peer.create');
    }

    sendPackets(peerId, target, count, options = {}) {
        return this.request('peer.send', {
            peerId,
            host: target.host,
            port: target.port,
            count,
            ...options
        }, Math.max(10_000, count * 100));
    }

    sendDtmf(peerId, target, digit, options = {}) {
        return this.request('peer.sendDtmf', {
            peerId,
            host: target.host,
            port: target.port,
            digit,
            ...options
        }, 10_000);
    }

    waitForPacket(peerId, timeoutMs) {
        return this.request('peer.wait', { peerId, timeoutMs }, timeoutMs + 1_000);
    }

    startAudioServer() {
        return this.request('audio.start', {}, 5_000);
    }

    closeAudioServer() {
        return this.request('audio.close', {}, 5_000);
    }

    closePeer(peerId) {
        return this.request('peer.close', { peerId }, 2_000);
    }

    async close() {
        if (this.closed) return;
        await this.request('shutdown', {}, 2_000).catch(() => undefined);
        if (!this.closed) {
            this.child.kill('SIGTERM');
            await new Promise(resolve => this.child.once('close', resolve));
        }
    }

    request(method, params = {}, timeoutMs = 10_000) {
        if (this.closed) return Promise.reject(new Error('RTP probe is closed'));
        const id = randomUUID();
        const payload = JSON.stringify({ id, method, params });
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RTP probe request timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        this.child.stdin.write(`${payload}\n`);
        return promise;
    }

    receive(chunk) {
        this.buffer += chunk;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) return;
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            const response = JSON.parse(line);
            const pending = this.pending.get(response.id);
            if (!pending) continue;
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (response.ok) pending.resolve(response.result);
            else pending.reject(new Error(response.error || 'RTP probe request failed'));
        }
    }
}

class SipResponderClient {
    constructor(child, info) {
        this.child = child;
        this.port = info.port;
        this.pending = new Map();
        this.buffer = '';
        this.closed = false;
        child.stdout.on('data', data => this.receive(data.toString()));
        child.stderr.on('data', data => {
            const text = data.toString();
            if (text.trim()) process.stderr.write(`[sip-responder] ${text}`);
        });
        child.on('close', code => {
            this.closed = true;
            const err = new Error(`SIP responder exited with ${code}`);
            for (const [id, pending] of this.pending) {
                clearTimeout(pending.timer);
                pending.reject(err);
                this.pending.delete(id);
            }
        });
    }

    static async start() {
        const child = spawn('docker', ['compose', '-f', composeFile, 'exec', '-T', 'gateway', 'node', 'scripts/sip-responder.mjs'], {
            cwd: new URL('..', import.meta.url),
            env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const bootstrap = new SipResponderClient(child, { port: undefined });
        const info = await bootstrap.request('ping', {}, 10_000);
        bootstrap.port = info.port;
        return bootstrap;
    }

    waitForEvent(event, timeoutMs) {
        return this.request('event.wait', { event, timeoutMs }, timeoutMs + 1_000);
    }

    async close() {
        if (this.closed) return;
        await this.request('shutdown', {}, 2_000).catch(() => undefined);
        if (!this.closed) {
            this.child.kill('SIGTERM');
            await new Promise(resolve => this.child.once('close', resolve));
        }
    }

    request(method, params = {}, timeoutMs = 10_000) {
        if (this.closed) return Promise.reject(new Error('SIP responder is closed'));
        const id = randomUUID();
        const payload = JSON.stringify({ id, method, params });
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`SIP responder request timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        this.child.stdin.write(`${payload}\n`);
        return promise;
    }

    receive(chunk) {
        this.buffer += chunk;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) return;
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            const response = JSON.parse(line);
            const pending = this.pending.get(response.id);
            if (!pending) continue;
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (response.ok) pending.resolve(response.result);
            else pending.reject(new Error(response.error || 'SIP responder request failed'));
        }
    }
}

class SipTcpClient {
    constructor(socket, localPort) {
        this.socket = socket;
        this.localPort = localPort;
        this.messages = [];
        this.waiters = [];
        this.buffer = '';
        socket.on('data', data => this.receive(data.toString()));
    }

    static async create() {
        const socket = net.createConnection({ host: drachtioHost, port: drachtioPort });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SIP TCP connect timeout')), 10_000);
            socket.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once('error', reject);
        });
        return new SipTcpClient(socket, socket.address().port);
    }

    buildInvite({ user }) {
        const callId = `${randomUUID()}@rtc-session-gateway-e2e`;
        const fromTag = randomToken();
        const branch = `z9hG4bK-${randomToken()}`;
        const uri = `sip:${user}@${drachtioHost}:${drachtioPort}`;
        const body = localSdp(this.localPort + 10);
        const headers = [
            `INVITE ${uri} SIP/2.0`,
            `Via: SIP/2.0/TCP 127.0.0.1:${this.localPort};branch=${branch};rport`,
            'Max-Forwards: 70',
            `From: "E2E Caller" <sip:caller@127.0.0.1>;tag=${fromTag}`,
            `To: <sip:${user}@127.0.0.1>`,
            `Call-ID: ${callId}`,
            'CSeq: 1 INVITE',
            `Contact: <sip:caller@127.0.0.1:${this.localPort};transport=tcp>`,
            'Content-Type: application/sdp',
            `Content-Length: ${Buffer.byteLength(body)}`
        ];
        return {
            callId,
            fromTag,
            uri,
            cseq: 1,
            message: `${headers.join('\r\n')}\r\n\r\n${body}`
        };
    }

    buildAck(invite, response) {
        const to = response.headers.to || response.headers.t;
        const contact = response.headers.contact?.match(/<([^>]+)>/)?.[1] || invite.uri;
        const headers = [
            `ACK ${contact} SIP/2.0`,
            `Via: SIP/2.0/TCP 127.0.0.1:${this.localPort};branch=z9hG4bK-${randomToken()};rport`,
            'Max-Forwards: 70',
            `From: "E2E Caller" <sip:caller@127.0.0.1>;tag=${invite.fromTag}`,
            `To: ${to}`,
            `Call-ID: ${invite.callId}`,
            `CSeq: ${invite.cseq} ACK`,
            `Contact: <sip:caller@127.0.0.1:${this.localPort};transport=tcp>`,
            'Content-Length: 0'
        ];
        return `${headers.join('\r\n')}\r\n\r\n`;
    }

    buildResponse(request, status, reason) {
        const headers = [
            `SIP/2.0 ${status} ${reason}`,
            ...request.via.map(value => `Via: ${value}`),
            `From: ${request.headers.from || request.headers.f}`,
            `To: ${request.headers.to || request.headers.t}`,
            `Call-ID: ${request.headers['call-id'] || request.headers.i}`,
            `CSeq: ${request.headers.cseq}`,
            'Content-Length: 0'
        ];
        return `${headers.join('\r\n')}\r\n\r\n`;
    }

    send(message) {
        this.socket.write(message);
    }

    receive(chunk) {
        this.buffer += chunk;
        while (true) {
            const parsed = takeSipMessage(this.buffer);
            if (!parsed) return;
            this.buffer = this.buffer.slice(parsed.raw.length);
            this.messages.push(parsed);
            for (const waiter of [...this.waiters]) {
                if (!waiter.matches(parsed)) continue;
                this.waiters = this.waiters.filter(candidate => candidate !== waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(parsed);
            }
        }
    }

    waitForFinalResponse(callId, timeoutMs) {
        return this.waitFor(message => message.kind === 'response' && message.status >= 200 && message.headers['call-id'] === callId, timeoutMs);
    }

    waitForRequest(method, callId, timeoutMs) {
        return this.waitFor(message => message.kind === 'request' && message.method === method && message.headers['call-id'] === callId, timeoutMs);
    }

    waitFor(matches, timeoutMs) {
        const existing = this.messages.find(matches);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for SIP message')), timeoutMs);
            this.waiters.push({ matches, resolve, reject, timer });
        });
    }

    close() {
        this.socket.end();
        this.socket.destroy();
    }
}

function takeSipMessage(buffer) {
    const separatorMatch = /\r?\n\r?\n/.exec(buffer);
    if (!separatorMatch) return undefined;
    const headEnd = separatorMatch.index;
    const separatorLength = separatorMatch[0].length;
    const head = buffer.slice(0, headEnd);
    const contentLengthLine = head.split(/\r?\n/).find(line => /^content-length\s*:/i.test(line));
    const contentLength = Number(contentLengthLine?.split(':')[1]?.trim() || 0);
    const totalLength = headEnd + separatorLength + contentLength;
    if (buffer.length < totalLength) return undefined;
    return parseSipMessage(buffer.slice(0, totalLength));
}

function parseSipMessage(raw) {
    const [head, body = ''] = raw.split(/\r?\n\r?\n/);
    const lines = head.split(/\r?\n/);
    const startLine = lines.shift() || '';
    const headers = {};
    const via = [];
    for (const line of lines) {
        const index = line.indexOf(':');
        if (index < 0) continue;
        const name = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (name === 'via' || name === 'v') via.push(value);
        headers[name] = value;
    }
    if (startLine.startsWith('SIP/2.0')) {
        const match = /^SIP\/2\.0\s+(\d+)/.exec(startLine);
        return { kind: 'response', raw, startLine, status: Number(match?.[1] || 0), headers, via, body };
    }
    const [method, uri] = startLine.split(/\s+/);
    return { kind: 'request', raw, startLine, method, uri, headers, via, body };
}

function localSdp(port) {
    return [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 127.0.0.1`,
        's=rtc-session-gateway-e2e',
        'c=IN IP4 127.0.0.1',
        't=0 0',
        `m=audio ${port} RTP/AVP 0 101`,
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:101 telephone-event/8000',
        'a=fmtp:101 0-16',
        'a=sendrecv'
    ].join('\r\n');
}

function rtpAnswer(host, port) {
    return [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 ${host}`,
        's=rtc-session-gateway-e2e',
        `c=IN IP4 ${host}`,
        't=0 0',
        `m=audio ${port} RTP/AVP 0 101`,
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:101 telephone-event/8000',
        'a=fmtp:101 0-16',
        'a=sendrecv'
    ].join('\r\n');
}

function parseRtpTarget(sdp, hostOverride) {
    const port = Number(/^m=audio\s+(\d+)/m.exec(sdp)?.[1]);
    const advertisedHost = /^c=IN IP[46]\s+([^\r\n]+)/m.exec(sdp)?.[1] || '127.0.0.1';
    const host = hostOverride || (advertisedHost === '0.0.0.0' || advertisedHost === '::' ? '127.0.0.1' : advertisedHost);
    assert(Number.isInteger(port) && port > 0, `could not parse RTP port from SDP: ${sdp}`);
    return { host, port };
}

function assertPcap(buffer, message) {
    assert(buffer.length > PCAP_HEADER_BYTES, `${message} should include a PCAP header and packet data`);
    const littleEndianMagic = buffer.readUInt32LE(0);
    const bigEndianMagic = buffer.readUInt32BE(0);
    const littleEndian = littleEndianMagic === 0xa1b2c3d4;
    const bigEndian = bigEndianMagic === 0xa1b2c3d4;
    assert(littleEndian || bigEndian, `${message} should use standard PCAP magic`);
    const linkType = littleEndian ? buffer.readUInt32LE(20) : buffer.readUInt32BE(20);
    assertEqual(linkType, 1, `${message} should use Ethernet link type`);
}

function encodeRecordingPath(recordingPath) {
    return recordingPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function randomToken() {
    return randomUUID().replace(/-/g, '').slice(0, 16);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertDeepEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
