#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import process from 'node:process';
import { e2eFetch as fetch } from './e2e-http.mjs';

import { RTCPeerConnection } from 'werift';

const gatewayBaseUrl = process.env.E2E_GATEWAY_URL || 'http://127.0.0.1:3001';
const rtpbridgeBaseUrl = process.env.E2E_RTPBRIDGE_URL || 'http://rtpbridge:9100';
const rtpbridgeBaseUrls = (process.env.E2E_RTPBRIDGE_URLS || rtpbridgeBaseUrl)
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
let audioServer;

async function main() {
    try {
        await runGatewayOfferScenario();
        await runRemoteOfferScenario();
        await runGatewayOfferScenario({ relay: true });
    } finally {
        await closeAudioServer();
    }
}

main()
    .then(() => {
        console.log('[webrtc-probe] complete');
        // Peer/server cleanup and backend leak checks have completed. Werift can
        // retain ICE timers, so terminate this standalone fixture explicitly.
        process.exit(0);
    })
    .catch(err => {
        console.error(`[webrtc-probe] failed: ${err?.stack || err}`);
        process.exit(1);
    });

async function runGatewayOfferScenario({ relay = false } = {}) {
    step(relay ? 'TURN-only gateway-offer negotiation' : 'gateway-offer negotiation and ICE restart');
    const session = await postJson(`${gatewayBaseUrl}/sessions`, { callId: `e2e-webrtc-gateway-offer-${randomUUID()}` });
    const sessionId = session.sessionId;
    let endpointId;
    let pc;
    let failure;
    try {
        const offer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/webrtc/offers`, {
            direction: 'sendrecv'
        });
        endpointId = offer.endpointId;
        assert(endpointId, 'webrtc.createOffer should return endpointId');
        assert(offer.sdpOffer?.includes('m=audio'), 'webrtc.createOffer should return audio SDP');
        const initialUfrag = iceUfrag(offer.sdpOffer);

        pc = createPeer(session, relay);
        await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdpOffer });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(pc, 'gateway-offer answer ICE gathering');
        await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(endpointId)}/webrtc/answer`, {
            sdp: peerSdp(pc, relay)
        });
        await waitForIceConnected(pc, 'gateway-offer initial ICE');
        if (relay) await eventually(async () => assertRelaySelected(pc), 15_000);
        await assertWebrtcReceivesPlayback(sessionId, pc);

        const tracked = await getJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`);
        assert(
            tracked.endpoints.some(endpoint => endpoint.endpointId === endpointId && endpoint.type === 'webrtc' && endpoint.direction === 'sendrecv'),
            'gateway session should track the WebRTC endpoint'
        );

        if (!relay) {
            const restart = await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(endpointId)}/webrtc/ice-restart`, {});
            const duplicateRestart = await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(endpointId)}/webrtc/ice-restart`, {});
            assertEqual(restart.offerGeneration, duplicateRestart.offerGeneration, 'duplicate pending ICE restart should reuse offerGeneration');
            assertEqual(restart.sdpOffer, duplicateRestart.sdpOffer, 'duplicate pending ICE restart should reuse SDP offer');
            assert(restart.offerGeneration >= 1, 'ICE restart should return an offerGeneration');
            assert(iceUfrag(restart.sdpOffer) !== initialUfrag, 'ICE restart should rotate the ICE ufrag');

            const initialPeerUfrag = iceUfrag(pc.localDescription.sdp);
            // Explicitly restart the test client's transports as well, so Werift
            // gathers fresh candidates and TURN allocations for this generation.
            for (const transport of pc.iceTransports) transport.restart();
            await pc.setRemoteDescription({ type: 'offer', sdp: restart.sdpOffer });
            const restartAnswer = await pc.createAnswer();
            await pc.setLocalDescription(restartAnswer);
            await waitForIceGatheringComplete(pc, 'gateway-offer restart answer ICE gathering');
            assert(iceUfrag(pc.localDescription.sdp) !== initialPeerUfrag, 'peer ICE restart should rotate credentials');
            await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(endpointId)}/webrtc/answer`, {
                sdp: peerSdp(pc, relay),
                offerGeneration: restart.offerGeneration
            });
            await waitForIceConnected(pc, 'gateway-offer restart ICE');
            await assertWebrtcReceivesPlayback(sessionId, pc);
        }
    } catch (err) {
        failure = err;
    }
    await finishWithCleanup(failure, [
        async () => { if (pc) await pc.close(); },
        async () => { if (endpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(endpointId)}`, {}); },
        async () => { if (sessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, {}); },
        async () => { await assertRtpbridgeSessionsEmpty(); }
    ]);
}

async function runRemoteOfferScenario() {
    step('remote-offer negotiation');
    const session = await postJson(`${gatewayBaseUrl}/sessions`, { callId: `e2e-webrtc-remote-offer-${randomUUID()}` });
    const sessionId = session.sessionId;
    let endpointId;
    let pc;
    let failure;
    try {
        pc = createPeer();
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(pc, 'remote-offer ICE gathering');

        const answer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/webrtc/from-offer`, {
            sdp: pc.localDescription?.sdp,
            direction: 'sendrecv'
        });
        endpointId = answer.endpointId;
        assert(endpointId, 'webrtc.createFromOffer should return endpointId');
        assert(answer.sdpAnswer?.includes('m=audio'), 'webrtc.createFromOffer should return audio SDP answer');

        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdpAnswer });
        await waitForIceConnected(pc, 'remote-offer ICE');
        await assertWebrtcReceivesPlayback(sessionId, pc);

        const tracked = await getJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`);
        assert(
            tracked.endpoints.some(endpoint => endpoint.endpointId === endpointId && endpoint.type === 'webrtc' && endpoint.direction === 'sendrecv'),
            'gateway session should track the remote-offer WebRTC endpoint'
        );
    } catch (err) {
        failure = err;
    }
    await finishWithCleanup(failure, [
        async () => { if (pc) await pc.close(); },
        async () => { if (endpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(endpointId)}`, {}); },
        async () => { if (sessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, {}); },
        async () => { await assertRtpbridgeSessionsEmpty(); }
    ]);
}

function createPeer(session, relay = false) {
    const turn = session?.iceConfiguration?.servers.find(server => server.urls.some(url => url.startsWith('turn:') && url.endsWith('transport=udp')));
    if (relay) assert(turn?.username && turn?.credential, 'gateway should issue TURN credentials');
    return new RTCPeerConnection({
        iceServers: relay ? [{ ...turn, urls: turn.urls.find(url => url.endsWith('transport=udp')) }] : [],
        iceTransportPolicy: relay ? 'relay' : 'all',
        iceFilterCandidatePair: relay ? pair => pair.localCandidate.type === 'relay' : undefined,
        bundlePolicy: 'max-bundle'
    });
}

function peerSdp(pc, relay) {
    const sdp = pc.localDescription.sdp;
    if (!relay) return sdp;
    // Werift still publishes host candidates under its relay policy. Restrict
    // both the advertised candidates and allowed pairs, then verify nomination.
    const lines = sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:') || line.includes(' typ relay'));
    const candidates = lines.filter(line => line.startsWith('a=candidate:'));
    assert(candidates.length > 0, 'TURN must allocate at least one relay candidate');
    assert(candidates.every(line => line.includes(' typ relay')), `relay-only SDP contained a direct candidate: ${candidates.join(', ')}`);
    return lines.join('\r\n');
}

function assertRelaySelected(pc) {
    assert(pc.iceTransports.length > 0, 'TURN call must have an ICE transport');
    for (const transport of pc.iceTransports) {
        assertEqual(transport.connection.nominated?.localCandidate.type, 'relay', 'selected ICE pair must use the TURN relay');
    }
}

async function assertWebrtcReceivesPlayback(sessionId, pc) {
    const audio = await startAudioServer();
    const observer = createRtpObserver(pc);
    const hitsBefore = audio.hits;
    const source = `${audio.url}?cacheBust=${randomUUID()}`;
    await observer.waitForNone(300, 'WebRTC should be quiet before media.play');
    const packetBaseline = observer.count;
    let playbackEndpointId;
    try {
        const playback = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/play`, {
            source
        });
        playbackEndpointId = playback.endpointId;
        assert(playbackEndpointId, 'media.play should return playback endpointId');
        await eventually(async () => {
            assert(audio.hits > hitsBefore, 'media.play should fetch the requested audio URL');
        }, 5_000);
        const packet = await observer.waitForNext(packetBaseline + 39, 10_000, '40 sustained WebRTC playback packets');
        assert(packet.payloadLength > 0, 'WebRTC playback RTP should include payload bytes');
    } finally {
        if (playbackEndpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(playbackEndpointId)}`, {}).catch(() => undefined);
    }
    await sleep(300);
    await observer.waitForNone(400, 'WebRTC should stop receiving after playback deletion');
}

async function startAudioServer() {
    if (audioServer) return audioServer.info;
    const wav = createToneWav();
    const state = { hits: 0 };
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (!req.url?.startsWith('/tone.wav')) {
            res.writeHead(404).end();
            return;
        }
        state.hits++;
        res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': wav.length
        });
        res.end(wav);
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(process.env.E2E_AUDIO_PORT || 0), '0.0.0.0', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const info = {
        url: `http://${process.env.E2E_AUDIO_HOST || primaryIpv4()}:${server.address().port}/tone.wav`,
        get hits() {
            return state.hits;
        }
    };
    audioServer = { server, sockets, info };
    return info;
}

async function closeAudioServer() {
    if (!audioServer) return;
    const { server, sockets } = audioServer;
    audioServer = undefined;
    await closeServer(server, sockets, 'audio server');
}

function createToneWav() {
    const sampleRate = 8000;
    const durationSeconds = 2;
    const samples = Math.floor(sampleRate * durationSeconds);
    const dataBytes = samples * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < samples; i++) {
        const value = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 12000);
        buffer.writeInt16LE(value, 44 + i * 2);
    }
    return buffer;
}

function primaryIpv4() {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) return address.address;
        }
    }
    return '127.0.0.1';
}

async function assertRtpbridgeSessionsEmpty() {
    await eventually(async () => {
        for (const url of rtpbridgeBaseUrls) {
            const body = await getJson(`${url}/sessions`);
            assertEqual(sessionListLength(body), 0, `WebRTC scenario cleanup should remove rtpbridge sessions (${url})`);
        }
    }, 10_000);
}

function sessionListLength(body) {
    if (Array.isArray(body)) return body.length;
    if (Array.isArray(body?.sessions)) return body.sessions.length;
    throw new Error(`Unexpected backend session list: ${JSON.stringify(body)}`);
}

function createRtpObserver(pc) {
    const packets = [];
    const waiters = [];

    const pushPacket = packet => {
        const summary = {
            payloadType: packet.header?.payloadType,
            sequenceNumber: packet.header?.sequenceNumber,
            payloadLength: packet.payload?.length ?? 0
        };
        packets.push(summary);
        for (const waiter of [...waiters]) {
            if (packets.length <= waiter.afterCount) continue;
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(summary);
        }
    };
    const subscribeTrack = track => {
        if (!track || track.kind !== 'audio') return;
        track.onReceiveRtp.subscribe(pushPacket);
    };

    for (const receiver of pc.getReceivers()) subscribeTrack(receiver.track);
    pc.onTrack.subscribe(subscribeTrack);

    return {
        get count() {
            return packets.length;
        },
        waitForNext(afterCount, timeoutMs, label) {
            if (packets.length > afterCount) return Promise.resolve(packets[packets.length - 1]);
            return new Promise((resolve, reject) => {
                const waiter = {
                    afterCount,
                    resolve,
                    timer: setTimeout(() => {
                        removeWaiter(waiters, waiter);
                        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
                    }, timeoutMs)
                };
                waiters.push(waiter);
            });
        },
        waitForNone(durationMs, label) {
            const baseline = packets.length;
            return new Promise((resolve, reject) => {
                const waiter = {
                    afterCount: baseline,
                    resolve: packet => {
                        reject(new Error(`${label}: unexpected RTP ${describePacket(packet)}`));
                    },
                    timer: setTimeout(() => {
                        removeWaiter(waiters, waiter);
                        resolve();
                    }, durationMs)
                };
                waiters.push(waiter);
            });
        }
    };
}

function removeWaiter(waiters, waiter) {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
}

function describePacket(packet) {
    return `pt=${packet.payloadType} seq=${packet.sequenceNumber} bytes=${packet.payloadLength}`;
}

async function waitForIceGatheringComplete(pc, label, timeoutMs = 10_000) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
        let done = false;
        const finish = err => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
        };
        const check = () => {
            if (pc.iceGatheringState === 'complete') {
                finish();
                return;
            }
            if (pc.iceConnectionState === 'failed' || pc.connectionState === 'failed') {
                finish(new Error(`${label} failed: ${pc.iceGatheringState}/${pc.iceConnectionState}/${pc.connectionState}`));
            }
        };
        const timer = setTimeout(() => {
            finish(new Error(`${label} timed out: ${pc.iceGatheringState}`));
        }, timeoutMs);
        pc.onicegatheringstatechange = check;
        pc.iceGatheringStateChange.subscribe(check);
        check();
    });
}

async function waitForIceConnected(pc, label, timeoutMs = 15_000) {
    if (iceIsConnected(pc)) return;
    await new Promise((resolve, reject) => {
        let done = false;
        const finish = err => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
        };
        const check = () => {
            if (iceIsConnected(pc)) {
                finish();
                return;
            }
            if (pc.iceConnectionState === 'failed' || pc.connectionState === 'failed') {
                finish(new Error(`${label} failed: ${pc.iceConnectionState}/${pc.connectionState}`));
            }
        };
        const timer = setTimeout(() => {
            finish(new Error(`${label} timed out: ${pc.iceConnectionState}/${pc.connectionState}`));
        }, timeoutMs);
        pc.oniceconnectionstatechange = check;
        pc.onconnectionstatechange = check;
        pc.iceConnectionStateChange.subscribe(check);
        pc.connectionStateChange.subscribe(check);
        check();
    });
}

function iceIsConnected(pc) {
    return (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') && pc.connectionState === 'connected';
}

function iceUfrag(sdp) {
    const line = sdp.split(/\r?\n/).find(part => part.startsWith('a=ice-ufrag:'));
    assert(line, 'SDP should include an ICE ufrag');
    return line.slice('a=ice-ufrag:'.length);
}

async function eventually(fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            await sleep(250);
        }
    }
    throw lastError || new Error(`condition not met within ${timeoutMs}ms`);
}

async function finishWithCleanup(primaryError, tasks) {
    const cleanupError = await runCleanup(tasks);
    if (primaryError) {
        if (cleanupError) console.error(`[webrtc-probe] cleanup failed after primary error: ${cleanupError?.stack || cleanupError}`);
        throw primaryError;
    }
    if (cleanupError) throw cleanupError;
}

async function runCleanup(tasks) {
    let firstError;
    for (const task of tasks) {
        try {
            await task();
        } catch (err) {
            if (!firstError) firstError = err;
            console.error(`[webrtc-probe] cleanup step failed: ${err?.stack || err}`);
        }
    }
    return firstError;
}

async function closeServer(server, sockets, label, timeoutMs = 2_000) {
    for (const socket of sockets ?? []) socket.destroy();
    await new Promise((resolve, reject) => {
        let done = false;
        const finish = err => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error(`${label} close timed out`)), timeoutMs);
        server.close(finish);
    });
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

process.on('exit', () => {
    if (audioServer) audioServer.server.close();
});

function step(message) {
    console.log(`[webrtc-probe] ${message}`);
}

function assert(value, message) {
    if (!value) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
