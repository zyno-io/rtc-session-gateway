#!/usr/bin/env node

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import process from 'node:process';

import { RTCPeerConnection } from 'werift';

const gatewayBaseUrl = process.env.E2E_GATEWAY_URL || 'http://127.0.0.1:3001';
const rtpbridgeBaseUrl = process.env.E2E_RTPBRIDGE_URL || 'http://rtpbridge:9100';
const rtpbridgeBaseUrls = (process.env.E2E_RTPBRIDGE_URLS || rtpbridgeBaseUrl)
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);

async function main() {
    step('outbound SIP bridge to WebRTC');
    let sip;
    let callback;
    let pc;
    let agentSessionId;
    let sipMediaSessionId;
    let webrtcEndpointId;
    let rtpEndpointId;
    let bridgeEndpointId;
    let outboundSessionId;
    let failure;

    try {
        sip = await SipRtpResponder.start();
        callback = await startCallbackServer();
        const agentSession = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-outbound-bridge' });
        const sipMediaSession = await postJson(`${gatewayBaseUrl}/sessions`, { callId: 'e2e-outbound-bridge' });
        agentSessionId = agentSession.sessionId;
        sipMediaSessionId = sipMediaSession.sessionId;
        assertEqual(agentSession.backendId, sipMediaSession.backendId, 'agent and SIP media sessions should share one rtpbridge backend');

        const webrtc = await createAnsweredWebrtcEndpoint(agentSessionId);
        pc = webrtc.pc;
        webrtcEndpointId = webrtc.endpointId;

        const rtpOffer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sipMediaSessionId)}/rtp/offers`, {
            direction: 'sendrecv',
            codecs: ['PCMU']
        });
        rtpEndpointId = rtpOffer.endpointId;
        assert(rtpEndpointId, 'rtp.createOffer should return endpointId');

        const invitePromise = sip.waitForEvent('invite', 10_000);
        const outbound = await postJson(`${gatewayBaseUrl}/calls`, {
            requestUri: `sip:e2e@gateway:${sip.port};transport=tcp`,
            sdp: rtpOffer.sdpOffer,
            receiverUrl: callback.url,
            headers: {
                From: '"E2E Agent" <sip:agent@rtc-session-gateway-e2e>',
                'X-E2E': 'outbound-bridge'
            }
        });
        outboundSessionId = outbound.sessionId;
        assert(outboundSessionId, 'outbound SIP should return sessionId');
        assert(outbound.sdp?.includes('m=audio'), 'outbound SIP should return remote SDP answer');
        const invite = await invitePromise;
        assertEqual(invite.headers['x-e2e'], 'outbound-bridge', 'outbound INVITE should carry custom header');

        await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(rtpEndpointId)}/rtp/answer`, {
            sdp: outbound.sdp
        });
        const bridge = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sipMediaSessionId)}/media/bridge`, {
            targetSessionId: agentSessionId,
            direction: 'sendrecv'
        });
        bridgeEndpointId = bridge.endpointId;
        assert(bridgeEndpointId, 'media.bridge should return bridge endpointId');

        const observer = createRtpObserver(pc);
        await sip.waitForEvent('ack', 10_000);
        await observer.waitForNone(300, 'WebRTC should be quiet before SIP responder RTP');
        const packetBaseline = observer.count;
        const sent = await sip.sendRtp(100);
        assertEqual(sent.sent, 100, 'SIP responder should send the expected RTP packet count');
        const packet = await observer.waitForNext(packetBaseline, 10_000, 'bridged outbound SIP RTP');
        assert(packet.payloadLength > 0, 'bridged outbound SIP RTP should reach the WebRTC agent');

        const terminatedPromise = callback.waitForEvent('terminated', 10_000);
        const byePromise = sip.waitForEvent('bye', 10_000);
        const expectedOutboundSessionId = outboundSessionId;
        await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(outboundSessionId)}`, { reason: 'e2e-outbound-bridge-complete' });
        outboundSessionId = undefined;
        await byePromise;
        const terminated = await terminatedPromise;
        assertEqual(terminated.callId, expectedOutboundSessionId, 'outbound bridge BYE should emit terminated callback');
    } catch (err) {
        failure = err;
    }
    await finishWithCleanup(failure, [
        async () => { if (bridgeEndpointId) await postJson(`${gatewayBaseUrl}/media/bridges/${encodeURIComponent(bridgeEndpointId)}/unbridge`, {}); },
        async () => { if (outboundSessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(outboundSessionId)}`, {}); },
        async () => { if (webrtcEndpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(webrtcEndpointId)}`, {}); },
        async () => { if (rtpEndpointId) await deleteJson(`${gatewayBaseUrl}/media/endpoints/${encodeURIComponent(rtpEndpointId)}`, {}); },
        async () => { if (agentSessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(agentSessionId)}`, {}); },
        async () => { if (sipMediaSessionId) await deleteJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sipMediaSessionId)}`, {}); },
        async () => { if (pc) await pc.close(); },
        async () => { if (callback) await callback.close(); },
        async () => { if (sip) await sip.close(); },
        async () => { await assertRtpbridgeSessionsEmpty(); }
    ]);
}

async function createAnsweredWebrtcEndpoint(sessionId) {
    const offer = await postJson(`${gatewayBaseUrl}/sessions/${encodeURIComponent(sessionId)}/webrtc/offers`, {
        direction: 'sendrecv'
    });
    assert(offer.endpointId, 'webrtc.createOffer should return endpointId');
    const pc = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: 'max-bundle'
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdpOffer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc, 'agent WebRTC answer ICE gathering');
    await postJson(`${gatewayBaseUrl}/endpoints/${encodeURIComponent(offer.endpointId)}/webrtc/answer`, {
        sdp: pc.localDescription?.sdp
    });
    await waitForIceConnected(pc, 'agent WebRTC ICE');
    return { endpointId: offer.endpointId, pc };
}

class SipRtpResponder {
    static async start() {
        const responder = new SipRtpResponder();
        await responder.listen();
        return responder;
    }

    events = [];
    waiters = [];
    connections = new Set();
    dialogs = new Map();

    async listen() {
        this.server = net.createServer(socket => {
            this.connections.add(socket);
            new SipConnection(socket, this);
            socket.on('close', () => this.connections.delete(socket));
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '0.0.0.0', () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        this.port = this.server.address().port;
    }

    pushEvent(event, data) {
        const index = this.waiters.findIndex(waiter => waiter.event === event);
        if (index >= 0) {
            const [waiter] = this.waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(data);
            return;
        }
        this.events.push({ event, data });
    }

    waitForEvent(event, timeoutMs) {
        const index = this.events.findIndex(candidate => candidate.event === event);
        if (index >= 0) {
            const [candidate] = this.events.splice(index, 1);
            return Promise.resolve(candidate.data);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const waiterIndex = this.waiters.findIndex(waiter => waiter.timer === timer);
                if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
                reject(new Error(`timed out waiting ${timeoutMs}ms for SIP ${event}`));
            }, timeoutMs);
            this.waiters.push({ event, resolve, reject, timer });
        });
    }

    registerDialog(callId, dialog) {
        this.dialogs.set(callId, dialog);
    }

    async sendRtp(count) {
        const dialog = [...this.dialogs.values()][0];
        if (!dialog?.remoteRtp) throw new Error('SIP dialog has no remote RTP target');
        for (let i = 0; i < count; i++) {
            await dialog.sendRtp();
            await sleep(20);
        }
        return { sent: count };
    }

    async close() {
        for (const dialog of this.dialogs.values()) await dialog.close();
        for (const socket of this.connections) socket.destroy();
        if (this.server) await closeServer(this.server, undefined, 'SIP responder');
    }
}

class SipConnection {
    buffer = '';
    dialogTag = randomToken();

    constructor(socket, responder) {
        this.socket = socket;
        this.responder = responder;
        socket.on('data', data => this.receive(data.toString()));
    }

    receive(chunk) {
        this.buffer += chunk;
        while (true) {
            const parsed = takeSipMessage(this.buffer);
            if (!parsed) return;
            this.buffer = this.buffer.slice(parsed.raw.length);
            this.handle(parsed).catch(err => {
                console.error(`[outbound-bridge-probe] SIP handler failed: ${err?.stack || err}`);
            });
        }
    }

    async handle(message) {
        if (message.kind !== 'request') return;
        this.responder.pushEvent(message.method.toLowerCase(), {
            method: message.method,
            uri: message.uri,
            headers: message.headers,
            body: message.body
        });

        if (message.method === 'INVITE') {
            const dialog = await RtpDialog.create(message.body);
            this.responder.registerDialog(message.headers['call-id'] || message.headers.i, dialog);
            this.sendResponse(message, 100, 'Trying');
            this.sendResponse(message, 200, 'OK', dialog.localSdp());
            return;
        }

        if (message.method === 'BYE') {
            this.sendResponse(message, 200, 'OK');
        }
    }

    sendResponse(request, status, reason, body = '') {
        const headers = [
            `SIP/2.0 ${status} ${reason}`,
            ...request.via.map(value => `Via: ${value}`),
            `From: ${request.headers.from || request.headers.f}`,
            `To: ${taggedToHeader(request.headers.to || request.headers.t, this.dialogTag)}`,
            `Call-ID: ${request.headers['call-id'] || request.headers.i}`,
            `CSeq: ${request.headers.cseq}`,
            `Contact: <sip:responder@${primaryIpv4()}:${this.responder.port};transport=tcp>`,
            ...(body ? ['Content-Type: application/sdp'] : []),
            `Content-Length: ${Buffer.byteLength(body)}`
        ];
        this.socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
    }
}

class RtpDialog {
    static async create(remoteSdp) {
        const dialog = new RtpDialog(parseRtpTarget(remoteSdp));
        await dialog.listen();
        return dialog;
    }

    sequence = Math.floor(Math.random() * 65535);
    timestamp = Math.floor(Math.random() * 0xffffffff);
    ssrc = Math.floor(Math.random() * 0xffffffff);

    constructor(remoteRtp) {
        this.remoteRtp = remoteRtp;
    }

    async listen() {
        this.socket = dgram.createSocket('udp4');
        await new Promise((resolve, reject) => {
            this.socket.once('error', reject);
            this.socket.bind(0, '0.0.0.0', () => {
                this.socket.off('error', reject);
                resolve();
            });
        });
        this.port = this.socket.address().port;
    }

    localSdp() {
        return [
            'v=0',
            `o=- ${Date.now()} 1 IN IP4 ${primaryIpv4()}`,
            's=rtc-session-gateway-outbound-bridge',
            `c=IN IP4 ${primaryIpv4()}`,
            't=0 0',
            `m=audio ${this.port} RTP/AVP 0 101`,
            'a=rtpmap:0 PCMU/8000',
            'a=rtpmap:101 telephone-event/8000',
            'a=fmtp:101 0-16',
            'a=sendrecv'
        ].join('\r\n');
    }

    sendRtp() {
        const packet = this.buildPacket();
        return new Promise((resolve, reject) => {
            this.socket.send(packet, this.remoteRtp.port, this.remoteRtp.host, err => err ? reject(err) : resolve());
        });
    }

    buildPacket() {
        const packet = Buffer.alloc(12 + 160, 0xff);
        packet[0] = 0x80;
        packet[1] = 0x00;
        packet.writeUInt16BE(this.sequence++ & 0xffff, 2);
        packet.writeUInt32BE(this.timestamp >>> 0, 4);
        packet.writeUInt32BE(this.ssrc >>> 0, 8);
        this.timestamp = (this.timestamp + 160) >>> 0;
        return packet;
    }

    close() {
        return new Promise(resolve => {
            if (!this.socket) {
                resolve();
                return;
            }
            this.socket.close(resolve);
            this.socket = undefined;
        });
    }
}

async function startCallbackServer() {
    const events = [];
    const waiters = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => {
            const event = body ? JSON.parse(body) : {};
            push(event.event, event);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{}');
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => {
            server.off('error', reject);
            resolve();
        });
    });

    function push(event, data) {
        const index = waiters.findIndex(waiter => waiter.event === event);
        if (index >= 0) {
            const [waiter] = waiters.splice(index, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(data);
            return;
        }
        events.push({ event, data });
    }

    return {
        url: `http://${primaryIpv4()}:${server.address().port}/events`,
        waitForEvent(event, timeoutMs) {
            const index = events.findIndex(candidate => candidate.event === event);
            if (index >= 0) {
                const [candidate] = events.splice(index, 1);
                return Promise.resolve(candidate.data);
            }
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const waiterIndex = waiters.findIndex(waiter => waiter.timer === timer);
                    if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
                    reject(new Error(`timed out waiting ${timeoutMs}ms for callback ${event}`));
                }, timeoutMs);
                waiters.push({ event, resolve, reject, timer });
            });
        },
        close() {
            return closeServer(server, sockets, 'callback server');
        }
    };
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
    return pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed' || pc.connectionState === 'connected';
}

async function assertRtpbridgeSessionsEmpty() {
    await eventually(async () => {
        for (const url of rtpbridgeBaseUrls) {
            const body = await getJson(`${url}/sessions`);
            assertEqual(sessionListLength(body), 0, `outbound bridge cleanup should remove rtpbridge sessions (${url})`);
        }
    }, 10_000);
}

function sessionListLength(body) {
    if (Array.isArray(body)) return body.length;
    if (Array.isArray(body?.sessions)) return body.sessions.length;
    return 0;
}

function parseRtpTarget(sdp) {
    const port = Number(/^m=audio\s+(\d+)/m.exec(sdp)?.[1]);
    const advertisedHost = /^c=IN IP[46]\s+([^\r\n]+)/m.exec(sdp)?.[1] || '127.0.0.1';
    assert(Number.isInteger(port) && port > 0, `could not parse RTP port from SDP: ${sdp}`);
    return { host: advertisedHost, port };
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

function taggedToHeader(value, tag) {
    if (!value) return `<sip:unknown@${primaryIpv4()}>;tag=${tag}`;
    if (/;\s*tag=/i.test(value)) return value;
    return `${value};tag=${tag}`;
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
        if (cleanupError) console.error(`[outbound-bridge-probe] cleanup failed after primary error: ${cleanupError?.stack || cleanupError}`);
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
            console.error(`[outbound-bridge-probe] cleanup step failed: ${err?.stack || err}`);
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

function primaryIpv4() {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) return address.address;
        }
    }
    return '127.0.0.1';
}

function randomToken() {
    return randomUUID().replace(/-/g, '').slice(0, 16);
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

function step(message) {
    console.log(`[outbound-bridge-probe] ${message}`);
}

main()
    .then(() => {
        step('complete');
    })
    .catch(err => {
        console.error(`[outbound-bridge-probe] failed: ${err?.stack || err}`);
        process.exit(1);
    });
