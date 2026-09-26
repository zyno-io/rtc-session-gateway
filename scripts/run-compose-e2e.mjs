#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import process from 'node:process';
import WebSocket from 'ws';
import { backendHeaders, backendTlsOptions, e2eFetch } from './e2e-http.mjs';
import { assertAudio, pcapRtp } from './e2e-media.mjs';

const secure = process.env.E2E_SECURE !== 'false';
process.env.E2E_SECURE = String(secure);
process.env.E2E_ALLOW_PLAINTEXT = String(!secure);
const backendScheme = secure ? 'https' : 'http';

const composeFile = 'docker-compose.e2e.yml';
const projectName = process.env.COMPOSE_PROJECT_NAME || `rtc-session-gateway-e2e-${process.pid}`;
const gatewayPort = process.env.E2E_GATEWAY_PORT || '3001';
const gatewayBaseUrl = process.env.E2E_GATEWAY_URL || `http://127.0.0.1:${gatewayPort}`;
const controlUrl = process.env.E2E_CONTROL_URL || `ws://127.0.0.1:${gatewayPort}/control`;
const drachtioHost = process.env.E2E_SIP_HOST || '127.0.0.1';
const drachtioPort = Number(process.env.E2E_SIP_PORT || 5060);
const rtpbridgeMediaHost = process.env.E2E_RTPBRIDGE_MEDIA_HOST;
const rtpbridgeHttpUrls = (process.env.E2E_RTPBRIDGE_URLS || `${backendScheme}://127.0.0.1:9100,${backendScheme}://127.0.0.1:9101`)
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
const inContainerRtpbridgeHttpUrls = process.env.E2E_CONTAINER_RTPBRIDGE_URLS || `${backendScheme}://rtpbridge:9100,${backendScheme}://rtpbridge-b:9101`;
const PCAP_HEADER_BYTES = 24;

const steps = [];
let control;
let fixturesDirectory;
let cleaningUp = false;
const startedAt = new Date().toISOString();

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
        void closeControl().then(() => cleanup(exitCode));
    });
}

async function main() {
    prepareFixtures();
    const env = {
        ...process.env,
        COMPOSE_PROJECT_NAME: projectName,
        RTPBRIDGE_IMAGE: process.env.RTPBRIDGE_IMAGE || pickRtpbridgeImage()
    };

    step(`Using compose project ${projectName}`);
    step(`Using rtpbridge image ${env.RTPBRIDGE_IMAGE}`);

    if (!process.env.RTPBRIDGE_IMAGE && !process.env.RTPBRIDGE_LOCAL_CHECKOUT) {
        run('docker', ['compose', '-f', composeFile, 'pull', 'rtpbridge', 'rtpbridge-b'], { env });
    }
    run('docker', ['compose', '-f', composeFile, 'up', '-d', '--build', '--remove-orphans'], { env });
    await waitForHttp(`${gatewayBaseUrl}/healthz`, body => body?.ok === true, 60_000);
    for (const url of rtpbridgeHttpUrls) {
        await waitForHttp(`${url}/health`, body => body?.status === 'ok', 60_000);
    }
    if (secure) await runBackendAuthenticationScenario();

    control = await connectControl(controlUrl);
    await control.request('route.register', { routes: [{ match: 'exact', value: 'e2e' }] });

    await runRejectScenario(control);
    await runAnswerAndHangupScenario(control);
    await runOutboundSipScenario(control);
    await runOutboundCancelScenario(control);
    await runReinviteScenario(control);
    await runMultiBackendScenario();
    await runCatalogAdmissionScenario();
    await runMediaScenario();
    await runMediaScenario({ srtp: true });
    await runWebrtcScenario();
    await runOutboundBridgeScenario();
    await runRecordingScenario();
    await runMediaActionsScenario();
    await runOwnerDisconnectScenario();
    await runConcurrentTeardownScenario();
    await runBackendFailureScenario();
    await runGatewayDrainScenario();
    await runGatewayDrainDeadlineScenario();

    step('E2E complete');
}

function prepareFixtures() {
    // Docker Desktop cannot reliably bind-mount macOS's private temp directory.
    fixturesDirectory = mkdtempSync(resolve('.e2e-fixtures-'));
    // Linux bind mounts retain permissions; rtpbridge runs as a non-root user.
    // These are public test identities and an ephemeral E2E-only HMAC key.
    chmodSync(fixturesDirectory, 0o755);
    process.env.E2E_FIXTURES_DIR = fixturesDirectory;
    let config = readFileSync('scripts/rtpbridge.e2e.toml', 'utf8');
    if (secure) {
        copyFileSync('test/fixtures/rtpbridge-cert.pem', `${fixturesDirectory}/cert.pem`);
        copyFileSync('test/fixtures/rtpbridge-key.pem', `${fixturesDirectory}/key.pem`);
        chmodSync(`${fixturesDirectory}/cert.pem`, 0o644);
        chmodSync(`${fixturesDirectory}/key.pem`, 0o644);
        writeFileSync(`${fixturesDirectory}/secret`, `${randomBytes(32).toString('hex')}\n`, {
            mode: 0o644
        });
        config = config.replace(/allow_(plaintext|unauthenticated)_control = true\n/g, '');
        config +=
            '\nauth_hmac_secret_file = "/etc/rtpbridge/secret"\n\n[tls]\ncert_path = "/etc/rtpbridge/cert.pem"\nkey_path = "/etc/rtpbridge/key.pem"\n';
        process.env.E2E_CONTAINER_SECRET_FILE = '/etc/rtpbridge/secret';
        process.env.E2E_CONTAINER_CA_FILE = '/etc/rtpbridge/cert.pem';
        process.env.RTPBRIDGE_AUTH_HMAC_SECRET_FILE = `${fixturesDirectory}/secret`;
        process.env.RTPBRIDGE_TLS_CA_FILE = `${fixturesDirectory}/cert.pem`;
        process.env.RTPBRIDGE_TLS_SERVERNAME = 'rtpbridge.test';
    }
    writeFileSync(`${fixturesDirectory}/rtpbridge.e2e.toml`, config);
    writeCatalog([true, true]);
}

function writeCatalog(admission) {
    const scheme = secure ? 'wss' : 'ws';
    const value = {
        schemaVersion: 1,
        revision: randomUUID(),
        backends: ['10.89.42.10', '10.89.42.11'].map((id, index) => ({
            id,
            acceptNew: admission[index],
            control: {
                url: `${scheme}://${id}:${index === 0 ? 9100 : 9101}/`,
                tlsServerName: 'rtpbridge.test'
            },
            recordings: {
                url: `${secure ? 'https' : 'http'}://${id}:${index === 0 ? 9100 : 9101}/`,
                tlsServerName: 'rtpbridge.test'
            }
        }))
    };
    const target = `${fixturesDirectory}/endpoints.json`;
    writeFileSync(`${target}.tmp`, JSON.stringify(value));
    renameSync(`${target}.tmp`, target);
    return value.revision;
}

async function runCatalogAdmissionScenario() {
    step('Checking atomic catalog drain keeps existing media and recording access without moving pinned calls');
    const callId = `catalog-${randomUUID()}`;
    const existing = await control.request('session.create', { callId });
    const index = existing.backendId === '10.89.42.10' ? 0 : 1;
    const admission = [true, true];
    admission[index] = false;
    let fresh;
    try {
        const revision = writeCatalog(admission);
        await eventually(async () => {
            const status = await getJson(`${gatewayBaseUrl}/routing/status`);
            assertEqual(status.media.revision, revision, 'gateway must observe the atomic replacement');
        }, 5000);
        await assertRejected(control.request('session.create', { callId }), /MEDIA_UNAVAILABLE/);
        fresh = await control.request('session.create', { callId: `fresh-${randomUUID()}` });
        assert(existing.backendId !== fresh.backendId, 'new work must use the admitting backend');
        await control.request('webrtc.createOffer', { sessionId: existing.sessionId });
        await getJson(`${gatewayBaseUrl}/recordings`);
    } finally {
        writeCatalog([true, true]);
        await control.request('session.delete', { sessionId: existing.sessionId });
        if (fresh) await control.request('session.delete', { sessionId: fresh.sessionId });
    }
}

async function runBackendAuthenticationScenario() {
    step('Checking real backend TLS and HTTP/WebSocket HMAC enforcement');
    for (const base of rtpbridgeHttpUrls) {
        for (const path of ['/sessions', '/recordings']) {
            const unsigned = await e2eFetch(`${base}${path}`, { headers: {} });
            assertEqual(unsigned.status, 401, 'backend should reject unsigned HTTP');
            const invalid = await e2eFetch(`${base}${path}`, { headers: backendHeaders('GET', `${base}${path}`, 'wrong-secret') });
            assertEqual(invalid.status, 401, 'backend should reject invalid HTTP HMAC');
        }
        const url = `${base.replace('https:', 'wss:')}/`;
        for (const headers of [{}, backendHeaders('GET', url, 'wrong-secret')]) await new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { ...backendTlsOptions(), headers, handshakeTimeout: 5_000 });
            ws.on('error', () => {});
            ws.on('unexpected-response', (_request, response) => {
                response.resume();
                ws.terminate();
                if (response.statusCode === 401) resolve();
                else reject(new Error(`unsigned WSS returned ${response.statusCode}`));
            });
            ws.on('open', () => { ws.terminate(); reject(new Error('unsigned WSS was accepted')); });
            ws.on('error', reject);
        });
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { ...backendTlsOptions(), servername: 'wrong-hostname.test', headers: backendHeaders('GET', url), handshakeTimeout: 5_000 });
            ws.on('open', () => { ws.terminate(); reject(new Error('TLS accepted the wrong hostname')); });
            ws.on('error', error => {
                if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') resolve();
                else reject(error);
            });
        });
        const response = await e2eFetch(`${base}/sessions`);
        assertEqual(response.status, 200, 'signed backend HTTP should succeed with verified TLS');
    }
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
        const deletePromise = deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}`, { reason: 'e2e-complete' });
        const bye = await byeRequest;
        sip.send(sip.buildResponse(bye, 200, 'OK'));
        await deletePromise;

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

async function runOutboundCancelScenario(controlClient) {
    step('Running pending outbound SIP cancellation scenario');
    const responder = await SipResponderClient.start();
    try {
        await responder.request('configure', { autoAnswer: false });
        const attemptId = randomUUID();
        const outboundResult = controlClient.request('sip.createOutbound', {
            outboundAttemptId: attemptId,
            requestUri: `sip:e2e@gateway:${responder.port};transport=tcp`,
            sdp: localSdp(42000)
        }, 15_000).then(result => ({ result }), error => ({ error }));
        await responder.waitForEvent('invite', 10_000);
        await controlClient.request('sip.cancelOutbound', { outboundAttemptId: attemptId });
        await responder.waitForEvent('cancel', 10_000);
        const outcome = await outboundResult;
        assert(outcome.error, 'cancelled outbound INVITE should reject the original command');
        await responder.waitForEvent('ack', 10_000);
        const calls = await getJson(`${gatewayBaseUrl}/calls`);
        assertEqual(calls.calls.length, 0, 'cancelled outbound INVITE should leave no active calls');
    } finally {
        await responder.close();
    }
    await assertRtpbridgeSessionsEmpty('cancelled outbound INVITE should leave no media');
}

async function runReinviteScenario(controlClient) {
    step('Running inbound SIP re-INVITE with RTP address change');
    const sip = await SipTcpClient.create();
    const probe = await RtpProbeClient.start();
    const media = await controlClient.request('session.create', { callId: 'e2e-reinvite' });
    let callId;
    try {
        const oldPeer = await probe.createPeer();
        const newPeer = await probe.createPeer();
        const observerPeer = await probe.createPeer();
        const invite = sip.buildInvite({ user: 'e2e', sdp: rtpAnswer(oldPeer.ip, oldPeer.port) });
        const inviteRequest = controlClient.waitForRequest('sip.invite', 10_000);
        const answeredEvent = controlClient.waitForEvent('sip.answered', 10_000);
        sip.send(invite.message);
        const request = await inviteRequest;
        const endpoint = await controlClient.request('rtp.createFromOffer', { sessionId: media.sessionId, sdp: request.params.sdp });
        controlClient.respond(request.id, { action: 'answer', sdp: endpoint.sdpAnswer });
        const answer = await sip.waitForFinalResponse(invite.callId, 10_000);
        assertEqual(answer.status, 200, 'initial INVITE status');
        sip.send(sip.buildAck(invite, answer));
        const answered = await answeredEvent;
        callId = answered.sessionId;
        const observer = await createAnsweredRtpEndpoint(media.sessionId, observerPeer);
        const target = parseRtpTarget(endpoint.sdpAnswer);
        const observerTarget = parseRtpTarget(observer.sdpOffer);
        await probe.sendPackets(observerPeer.peerId, observerTarget, 3);
        await probe.sendPackets(oldPeer.peerId, target, 3);
        await probe.request('peer.reset', { peerId: observerPeer.peerId });
        await probe.sendPackets(oldPeer.peerId, target, 50, { payloadMode: 'tone' });
        const before = await probe.request('peer.packets', { peerId: observerPeer.peerId });
        assertAudio(before, { minimum: 40, label: 'media before SIP re-INVITE' });

        const newSdp = rtpAnswer(newPeer.ip, newPeer.port);
        const reinvite = sip.buildReinvite(invite, answer, newSdp);
        const modifyRequest = controlClient.waitForRequest('sip.reinvite', 10_000);
        sip.send(reinvite.message);
        const modify = await modifyRequest;
        assertEqual(modify.params.sdp, newSdp, 'control should receive changed remote SDP');
        const renegotiated = await controlClient.request('rtp.reinvite', { endpointId: endpoint.endpointId, sdp: modify.params.sdp });
        controlClient.respond(modify.id, { action: 'answer', sdp: renegotiated.sdpAnswer });
        const final = await sip.waitForFinalResponse(invite.callId, 10_000, '2 INVITE');
        assertEqual(final.status, 200, 're-INVITE final status');
        sip.send(sip.buildAck(reinvite, final));
        const call = await getJson(`${gatewayBaseUrl}/calls/${encodeURIComponent(callId)}`);
        assertEqual(call.remoteSdp, newSdp, 'call should track renegotiated remote SDP');
        await probe.sendPackets(newPeer.peerId, parseRtpTarget(final.body), 3);
        await sleep(200);
        await probe.request('peer.reset', { peerId: newPeer.peerId });
        await probe.request('peer.reset', { peerId: oldPeer.peerId });
        await probe.sendPackets(observerPeer.peerId, observerTarget, 50, { payloadMode: 'tone' });
        await sleep(200);
        const after = await probe.request('peer.packets', { peerId: newPeer.peerId });
        const obsolete = await probe.request('peer.packets', { peerId: oldPeer.peerId });
        assertAudio(after, { minimum: 40, label: 'media after SIP re-INVITE' });
        assertEqual(obsolete.length, 0, 're-INVITE should stop sending to the old RTP address');
        const byePromise = sip.waitForRequest('BYE', invite.callId, 10_000);
        const deletePromise = controlClient.request('session.delete', { sessionId: callId });
        const bye = await byePromise;
        sip.send(sip.buildResponse(bye, 200, 'OK'));
        await deletePromise;
        callId = undefined;
    } finally {
        await controlClient.request('session.delete', { sessionId: media.sessionId }).catch(() => undefined);
        await probe.close();
        sip.close();
    }
    await assertRtpbridgeSessionsEmpty('re-INVITE cleanup should remove backend sessions');
}

async function assertGatewayEmpty(message) {
    await eventually(async () => {
        const calls = await getJson(`${gatewayBaseUrl}/calls`);
        const sessions = await getJson(`${gatewayBaseUrl}/sessions`);
        assertEqual(calls.calls.length, 0, `${message}: SIP calls`);
        assertEqual(sessions.sessions.length, 0, `${message}: media sessions`);
    }, 10_000);
    await assertRtpbridgeSessionsEmpty(message);
}

async function startPendingGather(sessionId, endpointId) {
    const pending = postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/gather`, {
        endpointId, numDigits: 2, timeoutMs: 12_000, sensitive: true
    });
    // Attach immediately so teardown failures cannot become unhandled rejections.
    pending.catch(() => undefined);
    await sleep(300);
    const conflict = await e2eFetch(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/media/gather`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpointId, numDigits: 1, timeoutMs: 100, sensitive: true })
    });
    assertEqual(conflict.status, 409, 'pending gather must be active before teardown');
    return { pending };
}

async function runOwnerDisconnectScenario() {
    step('Running control-owner disconnect with a live SIP call and pending media');
    const owner = await connectControl(controlUrl);
    const sip = await SipTcpClient.create();
    const probe = await RtpProbeClient.start();
    try {
        await owner.request('route.register', { routes: [{ match: 'exact', value: 'e2e-owner' }] });
        const media = await owner.request('session.create', { callId: 'e2e-owner' });
        const peer = await probe.createPeer();
        const endpoint = await createAnsweredRtpEndpoint(media.sessionId, peer);
        const invite = sip.buildInvite({ user: 'e2e-owner' });
        const requestPromise = owner.waitForRequest('sip.invite', 10_000);
        sip.send(invite.message);
        const request = await requestPromise;
        owner.respond(request.id, { action: 'answer', sdp: endpoint.sdpOffer });
        const answer = await sip.waitForFinalResponse(invite.callId, 10_000);
        assertEqual(answer.status, 200, 'owner call answer');
        sip.send(sip.buildAck(invite, answer));
        await owner.waitForEvent('sip.answered', 10_000);
        const gather = await startPendingGather(media.sessionId, endpoint.endpointId);
        const byePromise = sip.waitForRequest('BYE', invite.callId, 10_000);
        await owner.close();
        const bye = await byePromise;
        sip.send(sip.buildResponse(bye, 200, 'OK'));
        const result = await gather.pending;
        assertEqual(result.reason, 'cancelled', 'owner disconnect should cancel the active gather');
        await assertGatewayEmpty('owner disconnect cleanup');
    } finally {
        await owner.close();
        await probe.close();
        sip.close();
    }
}

async function runConcurrentTeardownScenario() {
    step('Running concurrent endpoint/session deletion and owner disconnect');
    const owner = await connectControl(controlUrl);
    const probe = await RtpProbeClient.start();
    try {
        const session = await owner.request('session.create', { callId: 'e2e-teardown-race' });
        const peer = await probe.createPeer();
        const endpoint = await createAnsweredRtpEndpoint(session.sessionId, peer);
        const gather = await startPendingGather(session.sessionId, endpoint.endpointId);
        const results = await Promise.all([
            e2eFetch(`${gatewayBaseUrl}/media/endpoints/${endpoint.endpointId}`, { method: 'DELETE' }),
            e2eFetch(`${gatewayBaseUrl}/sessions/${session.sessionId}`, { method: 'DELETE' }),
            owner.close()
        ]);
        for (const response of results.slice(0, 2)) assert([200, 404].includes(response.status), `teardown returned ${response.status}`);
        const result = await gather.pending;
        assertEqual(result.reason, 'cancelled', 'concurrent teardown should cancel pending gather');
        await assertGatewayEmpty('concurrent teardown cleanup');
        const fresh = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-after-race' });
        await deleteJson(`${gatewayBaseUrl}/sessions/${fresh.sessionId}`, {});
        await assertGatewayEmpty('gateway should remain usable after concurrent teardown');
    } finally {
        await owner.close();
        await probe.close();
    }
}

async function runBackendFailureScenario() {
    step('Running backend death, pending-action cancellation, isolation and recovery');
    const probe = await RtpProbeClient.start();
    const failed = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-backend-failure' });
    const healthy = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-backend-healthy' });
    assert(failed.backendId !== healthy.backendId, 'failure scenario requires distinct backends');
    const service = failed.backendId === '10.89.42.10' ? 'rtpbridge' : failed.backendId === '10.89.42.11' ? 'rtpbridge-b' : undefined;
    assert(service, `unknown backend mapping: ${failed.backendId}`);
    const base = rtpbridgeHttpUrls[service === 'rtpbridge' ? 0 : 1];
    try {
        const peer = await probe.createPeer();
        const endpoint = await createAnsweredRtpEndpoint(failed.sessionId, peer);
        const gather = await startPendingGather(failed.sessionId, endpoint.endpointId);
        run('docker', ['compose', '-f', composeFile, 'kill', '-s', 'SIGKILL', service], { env: { ...process.env, COMPOSE_PROJECT_NAME: projectName } });
        const result = await gather.pending;
        assertEqual(result.reason, 'cancelled', 'backend death should cancel pending gather');
        await eventually(async () => {
            const sessions = await getJson(`${gatewayBaseUrl}/sessions`);
            assert(!sessions.sessions.some(session => session.sessionId === failed.sessionId), 'dead backend session should be removed');
        }, 10_000);
        const survivor = await getJson(`${gatewayBaseUrl}/sessions/${healthy.sessionId}`);
        assertEqual(survivor.backendId, healthy.backendId, 'healthy backend session should survive');
        const working = await createAnsweredRtpEndpoint(healthy.sessionId, peer);
        assert(working.endpointId, 'healthy backend should still accept commands');
    } finally {
        run('docker', ['compose', '-f', composeFile, 'up', '-d', '--no-deps', service], { env: { ...process.env, COMPOSE_PROJECT_NAME: projectName } });
        await waitForHttp(`${base}/health`, body => body?.status === 'ok', 30_000);
        await deleteJson(`${gatewayBaseUrl}/sessions/${healthy.sessionId}`, {}).catch(() => undefined);
        await probe.close();
    }
    const recovered = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-backend-recovered' });
    assertEqual(recovered.backendId, failed.backendId, 'recovery should exercise the restarted backend');
    await postJson(`${gatewayBaseUrl}/sessions/${recovered.sessionId}/rtp/offers`, { codecs: ['PCMU'] });
    await deleteJson(`${gatewayBaseUrl}/sessions/${recovered.sessionId}`, {});
    await assertGatewayEmpty('backend failure and recovery cleanup');
}

async function runGatewayDrainScenario() {
    step('Draining gateway on SIGTERM with live SIP/RTP and an admitted INVITE');
    const sip = await SipTcpClient.create();
    const probe = await RtpProbeClient.start();
    const media = await control.request('session.create', {});
    try {
        const peer = await probe.createPeer();
        const observerPeer = await probe.createPeer();
        const invite = sip.buildInvite({ user: 'e2e', sdp: rtpAnswer(peer.ip, peer.port) });
        const inviteRequest = control.waitForRequest('sip.invite', 10_000);
        sip.send(invite.message);
        const request = await inviteRequest;
        const endpoint = await control.request('rtp.createFromOffer', { sessionId: media.sessionId, sdp: request.params.sdp });
        const answeredEvent = control.waitForEvent('sip.answered', 10_000);
        control.respond(request.id, { action: 'answer', sdp: endpoint.sdpAnswer });
        const answer = await sip.waitForFinalResponse(invite.callId, 10_000);
        assertEqual(answer.status, 200, 'call established before drain');
        sip.send(sip.buildAck(invite, answer));
        const answered = await answeredEvent;
        const observer = await createAnsweredRtpEndpoint(media.sessionId, observerPeer);
        await probe.sendPackets(observerPeer.peerId, parseRtpTarget(observer.sdpOffer), 3);
        await probe.sendPackets(peer.peerId, parseRtpTarget(endpoint.sdpAnswer), 3);

        const pendingInvite = sip.buildInvite({ user: 'e2e' });
        const pendingRequest = control.waitForRequest('sip.invite', 10_000);
        sip.send(pendingInvite.message);
        const admitted = await pendingRequest;
        const drainingEvent = control.waitForEvent('gateway.draining', 10_000);
        const env = { ...process.env, COMPOSE_PROJECT_NAME: projectName };
        run('docker', ['compose', '-f', composeFile, 'kill', '-s', 'SIGTERM', 'gateway'], { env });
        const event = await drainingEvent;
        assertEqual(event.data.reason, 'SIGTERM', 'signal should initiate gateway drain');
        run('docker', ['compose', '-f', composeFile, 'kill', '-s', 'SIGTERM', 'gateway'], { env });
        const readiness = await e2eFetch(`${gatewayBaseUrl}/readyz`);
        assertEqual(readiness.status, 503, 'draining gateway should leave readiness');
        const health = await getJson(`${gatewayBaseUrl}/healthz`);
        assertEqual(health.ok, true, 'draining gateway should remain healthy');
        const blocked = await e2eFetch(`${gatewayBaseUrl}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assertEqual(blocked.status, 503, 'drain should reject new HTTP sessions');
        await assertRejected(control.request('session.create', {}), /SHUTTING_DOWN/);
        await assertRejected(control.request('sip.createOutbound', { requestUri: 'sip:new@example.com', sdp: localSdp(41000) }), /SHUTTING_DOWN/);
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(controlUrl);
            ws.on('error', () => {});
            ws.on('unexpected-response', (_req, response) => {
                response.resume(); ws.terminate();
                if (response.statusCode === 503) resolve(); else reject(new Error(`draining upgrade status ${response.statusCode}`));
            });
            ws.on('open', () => { ws.terminate(); reject(new Error('draining gateway accepted a new control owner')); });
        });
        const newInvite = sip.buildInvite({ user: 'e2e' });
        sip.send(newInvite.message);
        const rejected = await sip.waitForFinalResponse(newInvite.callId, 10_000);
        assertEqual(rejected.status, 503, 'drain should reject new inbound SIP');

        const admittedMedia = await control.request('session.create', { callId: admitted.params.callId });
        const pendingAnswered = control.waitForEvent('sip.answered', 10_000);
        control.respond(admitted.id, { action: 'answer', sdp: localSdp(41002) });
        const pendingAnswer = await sip.waitForFinalResponse(pendingInvite.callId, 10_000);
        assertEqual(pendingAnswer.status, 200, 'admitted INVITE should finish setup during drain');
        sip.send(sip.buildAck(pendingInvite, pendingAnswer));
        const secondCall = await pendingAnswered;
        await probe.request('peer.reset', { peerId: observerPeer.peerId });
        await probe.sendPackets(peer.peerId, parseRtpTarget(endpoint.sdpAnswer), 50, { payloadMode: 'tone' });
        const packets = await probe.request('peer.packets', { peerId: observerPeer.peerId });
        assertAudio(packets, { minimum: 40, label: 'live SIP/RTP media during gateway drain' });
        const existing = await control.request('session.get', { sessionId: answered.sessionId });
        assertEqual(existing.callId, answered.sessionId, 'existing control owner should retain call access');
        for (const [callId, sipCallId] of [[answered.sessionId, invite.callId], [secondCall.sessionId, pendingInvite.callId]]) {
            const byeRequest = sip.waitForRequest('BYE', sipCallId, 10_000);
            const hangup = control.request('sip.bye', { sessionId: callId });
            const bye = await byeRequest;
            sip.send(sip.buildResponse(bye, 200, 'OK'));
            await hangup;
        }
        await control.request('session.delete', { sessionId: admittedMedia.sessionId });
        await control.request('session.delete', { sessionId: media.sessionId });
        await waitForGatewayExit();
        await assertRtpbridgeSessionsEmpty('natural gateway drain should finish without orphan sessions');
    } finally {
        sip.close();
        await probe.close();
    }
    await closeControl();
}

async function runGatewayDrainDeadlineScenario() {
    step('Checking gateway drain deadline, forced SIP/media cleanup and restart');
    const env = { ...process.env, COMPOSE_PROJECT_NAME: projectName, E2E_SHUTDOWN_MAX_WAIT_MS: '1000' };
    run('docker', ['compose', '-f', composeFile, 'up', '-d', '--no-deps', 'gateway'], { env });
    await waitForHttp(`${gatewayBaseUrl}/readyz`, body => body?.ok === true, 30_000);
    control = await connectControl(controlUrl);
    await control.request('route.register', { routes: [{ match: 'exact', value: 'e2e' }] });
    const sip = await SipTcpClient.create();
    const responder = await SipResponderClient.start();
    try {
        const media = await control.request('session.create', {});
        await control.request('rtp.createOffer', { sessionId: media.sessionId, codecs: ['PCMU'] });
        const invite = sip.buildInvite({ user: 'e2e' });
        const inviteRequest = control.waitForRequest('sip.invite', 10_000);
        const answeredEvent = control.waitForEvent('sip.answered', 10_000);
        sip.send(invite.message);
        const request = await inviteRequest;
        control.respond(request.id, { action: 'answer', sdp: localSdp(41000) });
        const answer = await sip.waitForFinalResponse(invite.callId, 10_000);
        assertEqual(answer.status, 200, 'deadline call established');
        sip.send(sip.buildAck(invite, answer));
        await answeredEvent;
        await responder.request('configure', { autoAnswer: false });
        const outbound = control.request('sip.createOutbound', {
            requestUri: `sip:e2e@gateway:${responder.port};transport=tcp`, sdp: localSdp(42000)
        }, 10_000).then(result => ({ result }), error => ({ error }));
        await responder.waitForEvent('invite', 10_000);
        const pendingInvite = sip.buildInvite({ user: 'e2e' });
        const pendingRequest = control.waitForRequest('sip.invite', 10_000);
        sip.send(pendingInvite.message);
        await pendingRequest;
        const byeRequest = sip.waitForRequest('BYE', invite.callId, 10_000);
        const inboundFinal = sip.waitForFinalResponse(pendingInvite.callId, 10_000);
        const cancelled = responder.waitForEvent('cancel', 10_000);
        const acknowledged = responder.waitForEvent('ack', 10_000);
        const response = await e2eFetch(`${gatewayBaseUrl}/terminate`, { method: 'POST' });
        assertEqual(response.status, 202, 'legacy terminate should initiate graceful drain');
        const bye = await byeRequest;
        sip.send(sip.buildResponse(bye, 200, 'OK'));
        const rejected = await inboundFinal;
        assertEqual(rejected.status, 503, 'deadline should reject admitted but unfinished inbound SIP');
        await cancelled;
        await acknowledged;
        const outcome = await outbound;
        assert(outcome.error, 'deadline should reject pending outbound command without a client attempt ID');
        await waitForGatewayExit();
        await assertRtpbridgeSessionsEmpty('deadline cleanup should destroy backend sessions');
    } finally {
        sip.close();
        await responder.close();
        await closeControl();
    }
    run('docker', ['compose', '-f', composeFile, 'up', '-d', '--no-deps', 'gateway'], { env });
    await waitForHttp(`${gatewayBaseUrl}/readyz`, body => body?.ok === true, 30_000);
    await assertGatewayEmpty('gateway restart after drain');
}

async function assertRejected(promise, pattern) {
    try { await promise; } catch (error) {
        assert(pattern.test(error.message), `Unexpected error: ${error.message}`);
        return;
    }
    throw new Error('Expected the operation to be rejected');
}

async function waitForGatewayExit() {
    const env = { ...process.env, COMPOSE_PROJECT_NAME: projectName };
    const containerId = execFileSync('docker', ['compose', '-f', composeFile, 'ps', '-a', '-q', 'gateway'], { env, encoding: 'utf8' }).trim();
    await eventually(async () => {
        const state = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .State}}', containerId], { encoding: 'utf8' }));
        assertEqual(state.Running, false, 'gateway should exit after draining');
        assertEqual(state.ExitCode, 0, 'gateway drain should exit successfully');
    }, 15_000);
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

async function runMediaScenario({ srtp = false } = {}) {
    step(srtp ? 'Running SDES-SRTP two-way media and plaintext rejection scenario' : 'Running rtpbridge media session scenario');
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
            srtp,
            codecs: ['PCMU']
        });
        targetOffer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(targetSessionId)}/rtp/offers`, {
            direction: 'sendrecv',
            srtp,
            codecs: ['PCMU']
        });
        assert(sourceOffer.endpointId, 'source rtp.createOffer should return endpointId');
        assert(sourceOffer.sdpOffer?.includes('m=audio'), 'source rtp.createOffer should return SDP offer');
        assert(targetOffer.endpointId, 'target rtp.createOffer should return endpointId');
        assert(targetOffer.sdpOffer?.includes('m=audio'), 'target rtp.createOffer should return SDP offer');

        const cryptoA = srtp ? await probe.request('peer.secure', { peerId: peerA.peerId, sdp: sourceOffer.sdpOffer }) : undefined;
        const cryptoB = srtp ? await probe.request('peer.secure', { peerId: peerB.peerId, sdp: targetOffer.sdpOffer }) : undefined;
        await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(sourceOffer.endpointId)}/rtp/answer`, {
            sdp: rtpAnswer(peerA.ip, peerA.port, cryptoA?.crypto)
        });
        await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(targetOffer.endpointId)}/rtp/answer`, {
            sdp: rtpAnswer(peerB.ip, peerB.port, cryptoB?.crypto)
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
        if (srtp) {
            await probe.sendPackets(peerA.peerId, sourceRtpTarget, 20, { payloadMode: 'tone', plaintext: true });
            await sleep(200);
            const rejected = await probe.request('peer.packets', { peerId: peerB.peerId });
            assertEqual(rejected.length, 0, 'mandatory SRTP should reject plaintext input');
        }
        await probe.sendPackets(peerA.peerId, sourceRtpTarget, 3);
        await probe.sendPackets(peerB.peerId, targetRtpTarget, 3);
        await sleep(200);
        await probe.request('peer.reset', { peerId: peerA.peerId });
        await probe.request('peer.reset', { peerId: peerB.peerId });
        await Promise.all([
            probe.sendPackets(peerA.peerId, sourceRtpTarget, 100, { payloadMode: 'tone', frequency: 440 }),
            probe.sendPackets(peerB.peerId, targetRtpTarget, 100, { payloadMode: 'tone', frequency: 660 })
        ]);
        await sleep(200);
        const receivedA = await probe.request('peer.packets', { peerId: peerA.peerId });
        const receivedB = await probe.request('peer.packets', { peerId: peerB.peerId });
        assertAudio(receivedA, { label: 'RTP B -> A', frequency: 660 });
        assertAudio(receivedB, { label: 'RTP A -> B', frequency: 440 });
        if (srtp) assert([...receivedA, ...receivedB].every(packet => packet.wireLength === packet.length + 10), 'SRTP packets should carry an authentication tag and decrypt successfully');

        for (const endpoint of [sourceOffer, targetOffer]) {
            await postJson(`${gatewayBaseUrl}/media/endpoints/${endpoint.endpointId}/direction`, { direction: 'inactive' });
        }
        await sleep(300);
        await probe.request('peer.reset', { peerId: peerA.peerId });
        await probe.request('peer.reset', { peerId: peerB.peerId });
        await Promise.all([
            probe.sendPackets(peerA.peerId, sourceRtpTarget, 30, { payloadMode: 'tone' }),
            probe.sendPackets(peerB.peerId, targetRtpTarget, 30, { payloadMode: 'tone' })
        ]);
        const inactiveA = await probe.request('peer.packets', { peerId: peerA.peerId });
        const inactiveB = await probe.request('peer.packets', { peerId: peerB.peerId });
        assertEqual(inactiveA.length, 0, 'inactive endpoint A should stop media');
        assertEqual(inactiveB.length, 0, 'inactive endpoint B should stop media');
        for (const endpoint of [sourceOffer, targetOffer]) {
            await postJson(`${gatewayBaseUrl}/media/endpoints/${endpoint.endpointId}/direction`, { direction: 'sendrecv' });
        }
        await Promise.all([
            probe.sendPackets(peerA.peerId, sourceRtpTarget, 70, { payloadMode: 'tone', frequency: 440 }),
            probe.sendPackets(peerB.peerId, targetRtpTarget, 70, { payloadMode: 'tone', frequency: 660 })
        ]);
        await sleep(200);
        const resumedA = await probe.request('peer.packets', { peerId: peerA.peerId });
        const resumedB = await probe.request('peer.packets', { peerId: peerB.peerId });
        assertAudio(resumedA, { minimum: 50, label: 'resumed RTP B -> A', frequency: 660 });
        assertAudio(resumedB, { minimum: 50, label: 'resumed RTP A -> B', frequency: 440 });

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
        await sleep(300);
        await probe.request('peer.reset', { peerId: peerA.peerId });
        await probe.request('peer.reset', { peerId: peerB.peerId });
        await Promise.all([
            probe.sendPackets(peerA.peerId, sourceRtpTarget, 40, { payloadMode: 'tone' }),
            probe.sendPackets(peerB.peerId, targetRtpTarget, 40, { payloadMode: 'tone' })
        ]);
        await sleep(200);
        const quietA = await probe.request('peer.packets', { peerId: peerA.peerId });
        const quietB = await probe.request('peer.packets', { peerId: peerB.peerId });
        assertEqual(quietA.length, 0, 'unbridge should stop media to A');
        assertEqual(quietB.length, 0, 'unbridge should stop media to B');
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
    run(
        'docker',
        [
            'compose',
            '-f',
            composeFile,
            'exec',
            '-T',
            '-e',
            `E2E_RTPBRIDGE_URLS=${inContainerRtpbridgeHttpUrls}`,
            '-e',
            'RTPBRIDGE_TLS_SERVERNAME=rtpbridge.test',
            'gateway',
            'node',
            'scripts/webrtc-probe.mjs'
        ],
        {
            timeout: 120_000,
            env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: projectName
            }
        }
    );
}

async function runOutboundBridgeScenario() {
    step('Running outbound SIP to WebRTC bridge scenario');
    run(
        'docker',
        [
            'compose',
            '-f',
            composeFile,
            'exec',
            '-T',
            '-e',
            `E2E_RTPBRIDGE_URLS=${inContainerRtpbridgeHttpUrls}`,
            '-e',
            'RTPBRIDGE_TLS_SERVERNAME=rtpbridge.test',
            'gateway',
            'node',
            'scripts/outbound-bridge-probe.mjs'
        ],
        {
            timeout: 120_000,
            env: {
                ...process.env,
                COMPOSE_PROJECT_NAME: projectName
            }
        }
    );
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
        const first = await recordSegment(sessionId, offer.endpointId, 'e2e recording-seg-1.pcap', peer.peerId, rtpTarget, probe);
        const second = await recordSegment(sessionId, offer.endpointId, 'e2e recording-seg-2.pcap', peer.peerId, rtpTarget, probe);
        stoppedRecordings.push(first, second);

        const listed = await getJson(`${gatewayBaseUrl}/recordings?startsWith=${encodeURIComponent('e2e recording-')}`);
        const listedPaths = listed.recordings.map(recording => recording.path).sort();
        assert(listedPaths.includes(first.recordingPath), 'recording list should include first real PCAP');
        assert(listedPaths.includes(second.recordingPath), 'recording list should include second real PCAP');

        const firstBytes = await getBinary(`${gatewayBaseUrl}${first.downloadPath}`);
        const secondBytes = await getBinary(`${gatewayBaseUrl}${second.downloadPath}`);
        assertPcap(firstBytes, 'first recording download');
        assertPcap(secondBytes, 'second recording download');
        const firstPackets = pcapRtp(firstBytes, offer.endpointId);
        const secondPackets = pcapRtp(secondBytes, offer.endpointId);
        assertAudio(firstPackets, { minimum: 45, label: 'decoded first recording' });
        assertAudio(secondPackets, { minimum: 45, label: 'decoded second recording' });

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
        assert(merged.body.equals(Buffer.concat([firstBytes, secondBytes.subarray(PCAP_HEADER_BYTES)])), 'merge should preserve every captured byte in order');
        const mergedPackets = pcapRtp(merged.body, offer.endpointId);
        assertEqual(mergedPackets.length, firstPackets.length + secondPackets.length, 'merged decoded packet count');
        assertAudio(mergedPackets, { minimum: 90, label: 'decoded merged recording' });
        if (process.env.E2E_ARTIFACTS_DIR) {
            mkdirSync(process.env.E2E_ARTIFACTS_DIR, { recursive: true });
            writeFileSync(`${process.env.E2E_ARTIFACTS_DIR}/merged.pcap`, merged.body);
        }
        for (const recording of stoppedRecordings) {
            await deleteJson(`${gatewayBaseUrl}/recordings/${encodeURIComponent(recording.backendId)}/${encodeRecordingPath(recording.recordingPath)}`, {});
            const missing = await e2eFetch(`${gatewayBaseUrl}${recording.downloadPath}`);
            assertEqual(missing.status, 404, 'deleted recording should no longer download');
        }
        const remaining = await getJson(`${gatewayBaseUrl}/recordings?startsWith=${encodeURIComponent('e2e recording-')}`);
        assertEqual(remaining.recordings.length, 0, 'deleted recordings should disappear from list');
        stoppedRecordings.length = 0;
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
        const gathered = await gatherPromise;
        assertDeepEqual(gathered, { digits: '44', reason: 'digits' }, 'media.gather should collect DTMF from RTP');

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
        const leftMessage = await leaveMessagePromise;
        assertDeepEqual(leftMessage, { terminator: 'silence', messagePlayed: true }, 'media.leaveMessage should wait for VAD silence and play message');
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
    await probe.sendPackets(peerId, rtpTarget, 50, { payloadMode: 'tone' });
    const stopped = await postJson(`${gatewayBaseUrl}/recordings/${encodeURIComponent(started.recordingId)}/stop`, {});
    assert(stopped.packets > 0, 'recording.stop should report captured packets');
    assertEqual(stopped.recordingPath, filePath, 'recording.stop should preserve requested path');
    assert(stopped.downloadPath, 'recording.stop should include gateway download path');
    return stopped;
}

function sessionListLength(body) {
    if (Array.isArray(body)) return body.length;
    if (Array.isArray(body?.sessions)) return body.sessions.length;
    throw new Error(`Unexpected backend session list: ${JSON.stringify(body)}`);
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
    const localCheckout = process.env.RTPBRIDGE_LOCAL_CHECKOUT;
    if (localCheckout) {
        if (!existsSync(`${localCheckout}/Dockerfile`)) {
            throw new Error(`RTPBRIDGE_LOCAL_CHECKOUT has no Dockerfile: ${localCheckout}`);
        }
        const tag = 'rtc-session-gateway-rtpbridge-e2e:local';
        step(`Building local rtpbridge image from ${localCheckout}`);
        run('docker', ['build', '-t', tag, localCheckout]);
        return tag;
    }

    return 'ghcr.io/zyno-io/rtpbridge:main';
}

function run(command, args, options = {}) {
    const display = `${command} ${args.join(' ')}`;
    step(display);
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        cwd: new URL('..', import.meta.url),
        timeout: 20 * 60_000,
        ...options
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${display} exited with ${result.status}`);
    }
}

function step(message) {
    steps.push(message);
    console.log(`\n[compose-e2e] ${message}`);
}

async function cleanup(exitCode) {
    if (cleaningUp) return;
    cleaningUp = true;
    if (process.env.E2E_ARTIFACTS_DIR) {
        const directory = process.env.E2E_ARTIFACTS_DIR;
        mkdirSync(directory, { recursive: true });
        const logs = spawnSync('docker', ['compose', '-f', composeFile, 'logs', '--no-color'], {
            env: { ...process.env, COMPOSE_PROJECT_NAME: projectName }, encoding: 'utf8'
        });
        writeFileSync(`${directory}/compose.log`, `${logs.stdout || ''}${logs.stderr || ''}`);
        writeFileSync(`${directory}/result.json`, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), secure, exitCode, steps }, null, 2));
    }
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
    if (fixturesDirectory) rmSync(fixturesDirectory, { recursive: true, force: true });
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
    const response = await e2eFetch(url);
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${text}`);
    return body;
}

async function postJson(url, body) {
    const response = await e2eFetch(url, {
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
    const response = await e2eFetch(url, {
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
    const response = await e2eFetch(url);
    const bytes = await response.arrayBuffer();
    const body = Buffer.from(bytes);
    if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${body.toString('utf8')}`);
    return body;
}

async function postBinary(url, body) {
    const response = await e2eFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const bytes = await response.arrayBuffer();
    const buffer = Buffer.from(bytes);
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

    buildInvite({ user, sdp }) {
        const callId = `${randomUUID()}@rtc-session-gateway-e2e`;
        const fromTag = randomToken();
        const branch = `z9hG4bK-${randomToken()}`;
        const uri = `sip:${user}@${drachtioHost}:${drachtioPort}`;
        const body = sdp || localSdp(this.localPort + 10);
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

    buildReinvite(invite, response, sdp) {
        const contact = response.headers.contact?.match(/<([^>]+)>/)?.[1] || invite.uri;
        const message = [
            `INVITE ${contact} SIP/2.0`,
            `Via: SIP/2.0/TCP 127.0.0.1:${this.localPort};branch=z9hG4bK-${randomToken()};rport`,
            'Max-Forwards: 70',
            `From: "E2E Caller" <sip:caller@127.0.0.1>;tag=${invite.fromTag}`,
            `To: ${response.headers.to}`,
            `Call-ID: ${invite.callId}`,
            'CSeq: 2 INVITE',
            `Contact: <sip:caller@127.0.0.1:${this.localPort};transport=tcp>`,
            'Content-Type: application/sdp',
            `Content-Length: ${Buffer.byteLength(sdp)}`
        ].join('\r\n') + `\r\n\r\n${sdp}`;
        return { ...invite, cseq: 2, message };
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

    waitForFinalResponse(callId, timeoutMs, cseq = '1 INVITE') {
        return this.waitFor(message => message.kind === 'response' && message.status >= 200 && message.headers['call-id'] === callId && message.headers.cseq === cseq, timeoutMs);
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

function rtpAnswer(host, port, crypto) {
    return [
        'v=0',
        `o=- ${Date.now()} 1 IN IP4 ${host}`,
        's=rtc-session-gateway-e2e',
        `c=IN IP4 ${host}`,
        't=0 0',
        `m=audio ${port} ${crypto ? 'RTP/SAVP' : 'RTP/AVP'} 0 101`,
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:101 telephone-event/8000',
        'a=fmtp:101 0-16',
        ...(crypto ? [crypto] : []),
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
