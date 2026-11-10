import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
function randomToken() {
    return randomUUID().replace(/-/g, '').slice(0, 16);
}
function fixtureSdp(host, port) {
    return `v=0\r\no=- 1 1 IN IP4 ${host}\r\ns=RTC fixture\r\nc=IN IP4 ${host}\r\nt=0 0\r\nm=audio ${port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n`;
}
export class SipStreamPeer {
    constructor(socket, localPort, options = {}) {
        this.options = options;
        this.transport = options.tls ? 'TLS' : 'TCP';
        this.advertisedHost = options.advertisedHost || '127.0.0.1';
        this.host = options.domain || options.host || '127.0.0.1';
        this.port = options.port || 5060;
        this.socket = socket;
        this.localPort = localPort;
        this.messages = [];
        this.waiters = [];
        this.buffer = '';
        socket.on('error', () => this.close());
        socket.on('close', () => this.close());
        socket.on('data', data => this.receive(data.toString()));
    }

    static async create(options = {}) {
        const address = { host: options.host || '127.0.0.1', port: options.port || 5060 };
        const socket = options.tls
            ? tls.connect({ ...address, servername: options.domain, ca: options.ca, rejectUnauthorized: true })
            : net.createConnection(address);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('SIP stream connect timeout'));
            }, 10000);
            socket.once(options.tls ? 'secureConnect' : 'connect', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once('error', error => {
                clearTimeout(timer);
                socket.destroy();
                reject(error);
            });
        });
        return new SipStreamPeer(socket, socket.address().port, options);
    }

    buildInvite({ user, sdp }) {
        const callId = `${randomUUID()}@rtc-session-gateway-e2e`;
        const fromTag = randomToken();
        const branch = `z9hG4bK-${randomToken()}`;
        const uri = `sip:${user}@${this.host}:${this.port}`;
        const body = sdp || this.options.defaultSdp || fixtureSdp(this.advertisedHost, this.localPort + 10);
        const headers = [
            `INVITE ${uri} SIP/2.0`,
            `Via: SIP/2.0/${this.transport} ${this.advertisedHost}:${this.localPort};branch=${branch};rport`,
            'Max-Forwards: 70',
            `From: "E2E Caller" <sip:caller@127.0.0.1>;tag=${fromTag}`,
            `To: <sip:${user}@127.0.0.1>`,
            `Call-ID: ${callId}`,
            'CSeq: 1 INVITE',
            `Contact: <sip:caller@${this.advertisedHost}:${this.localPort};transport=${this.transport.toLowerCase()}>`,
            'Content-Type: application/sdp',
            `Content-Length: ${Buffer.byteLength(body)}`
        ];
        return {
            callId,
            fromTag,
            branch,
            uri,
            cseq: 1,
            message: `${headers.join('\r\n')}\r\n\r\n${body}`
        };
    }

    buildAck(invite, response) {
        const to = response.headers.to || response.headers.t;
        const contact = response.status >= 300 ? invite.uri : response.headers.contact?.match(/<([^>]+)>/)?.[1] || invite.uri;
        const headers = [
            `ACK ${contact} SIP/2.0`,
            `Via: SIP/2.0/${this.transport} ${this.advertisedHost}:${this.localPort};branch=${response.status >= 300 ? invite.branch : 'z9hG4bK-' + randomToken()};rport`,
            'Max-Forwards: 70',
            `From: "E2E Caller" <sip:caller@127.0.0.1>;tag=${invite.fromTag}`,
            `To: ${to}`,
            `Call-ID: ${invite.callId}`,
            `CSeq: ${invite.cseq} ACK`,
            `Contact: <sip:caller@${this.advertisedHost}:${this.localPort};transport=${this.transport.toLowerCase()}>`,
            'Content-Length: 0'
        ];
        return `${headers.join('\r\n')}\r\n\r\n`;
    }

    buildReinvite(invite, response, sdp) {
        const contact = response.headers.contact?.match(/<([^>]+)>/)?.[1] || invite.uri;
        const message =
            [
                `INVITE ${contact} SIP/2.0`,
                `Via: SIP/2.0/${this.transport} ${this.advertisedHost}:${this.localPort};branch=z9hG4bK-${randomToken()};rport`,
                'Max-Forwards: 70',
                `From: "E2E Caller" <sip:caller@127.0.0.1>;tag=${invite.fromTag}`,
                `To: ${response.headers.to}`,
                `Call-ID: ${invite.callId}`,
                'CSeq: 2 INVITE',
                `Contact: <sip:caller@${this.advertisedHost}:${this.localPort};transport=${this.transport.toLowerCase()}>`,
                'Content-Type: application/sdp',
                `Content-Length: ${Buffer.byteLength(sdp)}`
            ].join('\r\n') + `\r\n\r\n${sdp}`;
        return { ...invite, cseq: 2, message };
    }

    buildBye(invite, response) {
        const uri = response.headers.contact?.match(/<([^>]+)>/)?.[1] || invite.uri;
        return [
            `BYE ${uri} SIP/2.0`,
            `Via: SIP/2.0/${this.transport} ${this.advertisedHost}:${this.localPort};branch=z9hG4bK-${randomToken()};rport`,
            'Max-Forwards: 70',
            `From: "Acceptance" <sip:caller@127.0.0.1>;tag=${invite.fromTag}`,
            `To: ${response.headers.to}`,
            `Call-ID: ${invite.callId}`,
            `CSeq: ${invite.cseq + 1} BYE`,
            'Content-Length: 0',
            '',
            ''
        ].join('\r\n');
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
        if (Buffer.byteLength(this.buffer) > 1048576) {
            this.close();
            return;
        }
        while (true) {
            const parsed = takeSipMessage(this.buffer);
            if (!parsed) return;
            this.buffer = this.buffer.slice(parsed.raw.length);
            this.messages.push(parsed);
            if (this.messages.length > 512) this.messages.shift();
            for (const waiter of [...this.waiters]) {
                if (!waiter.matches(parsed)) continue;
                this.waiters = this.waiters.filter(candidate => candidate !== waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(parsed);
            }
        }
    }

    waitForFinalResponse(callId, timeoutMs, cseq = '1 INVITE') {
        return this.waitFor(
            message => message.kind === 'response' && message.status >= 200 && message.headers['call-id'] === callId && message.headers.cseq === cseq,
            timeoutMs
        );
    }

    waitForRequest(method, callId, timeoutMs) {
        return this.waitFor(message => message.kind === 'request' && message.method === method && message.headers['call-id'] === callId, timeoutMs);
    }

    waitFor(matches, timeoutMs) {
        const existing = this.messages.find(matches);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const waiter = { matches, resolve, reject, timer: undefined };
            waiter.timer = setTimeout(() => {
                this.waiters = this.waiters.filter(value => value !== waiter);
                reject(new Error('timed out waiting for SIP message'));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error('SIP peer closed'));
        }
        this.waiters = [];
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
        return {
            kind: 'response',
            raw,
            startLine,
            status: Number(match?.[1] || 0),
            headers,
            via,
            body
        };
    }
    const [method, uri] = startLine.split(/\s+/);
    return { kind: 'request', raw, startLine, method, uri, headers, via, body };
}
