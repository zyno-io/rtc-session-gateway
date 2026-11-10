import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { SipStreamPeer } from './support/sip-stream-peer.mjs';
import { assertAudio, pcmuTone, parseRtp, pcapRtp } from './e2e-media.mjs';

const env = process.env;
const base = env.RTC_ACCEPTANCE_GATEWAY_URL;
const ip = env.RTC_ACCEPTANCE_ADVERTISE_IP;
const domain = env.RTC_ACCEPTANCE_SIP_DOMAIN;
const route = env.RTC_ACCEPTANCE_ROUTE || 'rtc-acceptance';
const report = {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    checks: [],
    ok: false,
    scope: 'native-sip-rtp-recording-network-acceptance'
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(path, method = 'GET', body, binary = false) {
    const token = readFileSync(env.RTC_ACCEPTANCE_TOKEN_FILE, 'utf8').trim();
    const response = await fetch(new URL(path, base), {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
        redirect: 'error'
    });
    if (!response.ok) throw new Error('RTC_API_' + response.status);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}
async function peer() {
    const socket = dgram.createSocket('udp4');
    const packets = [];
    socket.on('message', bytes => {
        try {
            const parsed = parseRtp(bytes);
            if (packets.length < 2000) packets.push(parsed);
        } catch {}
    });
    await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve));
    return {
        socket,
        packets,
        port: socket.address().port,
        sdp: () =>
            `v=0\r\no=- 1 1 IN IP4 ${ip}\r\ns=RTC acceptance\r\nc=IN IP4 ${ip}\r\nt=0 0\r\nm=audio ${socket.address().port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n`
    };
}
async function sendTone(peer, sdp, frequency) {
    const host = /^c=IN IP4 ([^\r\n]+)/m.exec(sdp)?.[1];
    const port = Number(/^m=audio (\d+)/m.exec(sdp)?.[1]);
    assert(host && port > 0, 'RTP answer must contain a target');
    for (let n = 0; n < 120; n++) {
        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = 0;
        header.writeUInt16BE(n, 2);
        header.writeUInt32BE(n * 160, 4);
        header.writeUInt32BE(frequency, 8);
        await new Promise((resolve, reject) =>
            peer.socket.send(Buffer.concat([header, pcmuTone(n * 160, frequency)]), port, host, error => (error ? reject(error) : resolve()))
        );
        await sleep(20);
    }
}
async function main() {
    assert(base && ['http:', 'https:'].includes(new URL(base).protocol), 'RTC_ACCEPTANCE_GATEWAY_URL is required');
    assert(isIP(ip) === 4 && domain, 'Explicit routable IPv4 and SIP domain are required');
    assert(/^rtc-acceptance(?:-[a-z0-9]+)*$/.test(route), 'Only acceptance routes can be probed');
    const sip = await SipStreamPeer.create({
        host: env.RTC_ACCEPTANCE_SIP_HOST || domain,
        port: Number(env.RTC_ACCEPTANCE_SIP_PORT || 5061),
        domain,
        tls: env.RTC_ACCEPTANCE_SIP_PLAINTEXT !== 'true',
        advertisedHost: ip,
        ca: env.RTC_ACCEPTANCE_SIP_CA_FILE ? readFileSync(env.RTC_ACCEPTANCE_SIP_CA_FILE) : undefined
    });
    const a = await peer(),
        b = await peer();
    let media, observerMedia, recording, invite, answer;
    try {
        const reject = sip.buildInvite({ user: route + '-reject', sdp: a.sdp() });
        sip.send(reject.message);
        const denied = await sip.waitForFinalResponse(reject.callId, 15000);
        assert.equal(denied.status, 486);
        sip.send(sip.buildAck(reject, denied));
        report.checks.push('inbound-reject-486');
        invite = sip.buildInvite({ user: route, sdp: a.sdp() });
        sip.send(invite.message);
        answer = await sip.waitForFinalResponse(invite.callId, 15000);
        assert.equal(answer.status, 200);
        sip.send(sip.buildAck(invite, answer));
        report.checks.push('inbound-answer-ack');
        for (let i = 0; i < 50 && !media; i++) {
            const sessions = await api('/sessions');
            const values = Array.isArray(sessions) ? sessions : sessions.sessions;
            media = values.find(value => value.callId === invite.callId && value.backendId);
            if (!media) await sleep(100);
        }
        assert(media, 'Accepted call must own media');
        observerMedia = await api('/sessions', 'POST', { callId: invite.callId });
        const observer = await api(`/sessions/${encodeURIComponent(observerMedia.sessionId)}/rtp/offers`, 'POST', { codecs: ['PCMU'] });
        await api(`/endpoints/${encodeURIComponent(observer.endpointId)}/rtp/answer`, 'POST', { sdp: b.sdp() });
        const detail = await api(`/sessions/${encodeURIComponent(media.sessionId)}`);
        const original = detail.endpoints.find(value => value.type === 'rtp' && value.endpointId !== observer.endpointId);
        assert(original, 'Original SIP RTP endpoint required');
        await api(`/sessions/${encodeURIComponent(media.sessionId)}/media/bridge`, 'POST', {
            targetSessionId: observerMedia.sessionId
        });
        recording = await api(`/sessions/${encodeURIComponent(media.sessionId)}/recordings`, 'POST', {
            endpointId: original.endpointId,
            filePath: `sg_acceptance_${report.runId}.pcap`
        });
        await Promise.all([sendTone(a, answer.body, 440), sendTone(b, observer.sdpOffer, 660)]);
        await sleep(200);
        assertAudio(a.packets, { minimum: 70, frequency: 660 });
        assertAudio(b.packets, { minimum: 70, frequency: 440 });
        report.checks.push('bidirectional-decoded-rtp');
        const modified = sip.buildReinvite(invite, answer, a.sdp());
        sip.send(modified.message);
        const updated = await sip.waitForFinalResponse(invite.callId, 15000, '2 INVITE');
        assert.equal(updated.status, 200);
        sip.send(sip.buildAck(modified, updated));
        invite = modified;
        report.checks.push('remote-reinvite');
        const stopped = await api(`/recordings/${encodeURIComponent(recording.recordingId)}/stop`, 'POST', {});
        const bytes = await api(stopped.downloadPath, 'GET', undefined, true);
        assert(bytes.length > 24);
        assertAudio(pcapRtp(bytes, original.endpointId), { minimum: 70, frequency: 440 });
        report.checks.push('decoded-recording');
        const bye = sip.buildBye(invite, answer);
        sip.send(bye);
        const final = await sip.waitForFinalResponse(invite.callId, 15000, '3 BYE');
        assert.equal(final.status, 200);
        invite = undefined;
        report.checks.push('remote-bye');
        await api(stopped.downloadPath, 'DELETE');
        recording = undefined;
        report.ok = true;
    } finally {
        if (invite && answer) {
            try {
                sip.send(sip.buildBye(invite, answer));
            } catch {}
        }
        if (recording?.recordingId) await api(`/recordings/${encodeURIComponent(recording.recordingId)}/stop`, 'POST', {}).catch(() => undefined);
        if (observerMedia) await api(`/sessions/${encodeURIComponent(observerMedia.sessionId)}`, 'DELETE').catch(() => undefined);
        if (media) await api(`/sessions/${encodeURIComponent(media.sessionId)}`, 'DELETE').catch(() => undefined);
        a.socket.close();
        b.socket.close();
        sip.close();
    }
}
try {
    await main();
} catch {
    report.ok = false;
    report.failure = 'NETWORK_ACCEPTANCE_FAILED';
    process.exitCode = 1;
} finally {
    report.finishedAt = new Date().toISOString();
    const data = JSON.stringify(report, null, 2);
    if (env.RTC_ACCEPTANCE_REPORT_FILE) writeFileSync(env.RTC_ACCEPTANCE_REPORT_FILE, data + '\n');
    console.log(data);
}
