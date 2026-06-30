#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import process from 'node:process';
import readline from 'node:readline';

const events = [];
const waiters = [];
const connections = new Set();

const server = net.createServer(socket => {
    connections.add(socket);
    new SipConnection(socket);
    socket.on('close', () => connections.delete(socket));
});

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
    });
});

const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
});

rl.on('line', line => {
    if (!line.trim()) return;
    let request;
    try {
        request = JSON.parse(line);
    } catch (err) {
        write({ id: undefined, ok: false, error: String(err?.message || err) });
        return;
    }

    Promise.resolve(handleRequest(request))
        .then(result => write({ id: request.id, ok: true, result }))
        .catch(err => write({ id: request.id, ok: false, error: String(err?.message || err) }));
});

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

async function handleRequest(request) {
    const params = request.params ?? {};
    switch (request.method) {
        case 'ping':
            return { ok: true, ip: primaryIpv4(), port: server.address().port };
        case 'event.wait':
            return waitForEvent(requiredString(params.event, 'event'), params.timeoutMs ?? 5_000);
        case 'shutdown':
            setImmediate(() => shutdown(0));
            return { ok: true };
        default:
            throw new Error(`unknown responder method ${request.method}`);
    }
}

class SipConnection {
    buffer = '';
    dialogTag = randomToken();

    constructor(socket) {
        this.socket = socket;
        socket.on('data', data => this.receive(data.toString()));
    }

    receive(chunk) {
        this.buffer += chunk;
        while (true) {
            const parsed = takeSipMessage(this.buffer);
            if (!parsed) return;
            this.buffer = this.buffer.slice(parsed.raw.length);
            this.handle(parsed);
        }
    }

    handle(message) {
        if (message.kind !== 'request') return;
        pushEvent(message.method.toLowerCase(), {
            method: message.method,
            uri: message.uri,
            headers: message.headers,
            body: message.body
        });

        if (message.method === 'INVITE') {
            this.sendResponse(message, 100, 'Trying');
            this.sendResponse(message, 200, 'OK', localSdp(43000));
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
            `Contact: <sip:responder@${primaryIpv4()}:${server.address().port};transport=tcp>`,
            ...(body ? ['Content-Type: application/sdp'] : []),
            `Content-Length: ${Buffer.byteLength(body)}`
        ];
        this.socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
    }
}

function pushEvent(event, data) {
    const index = waiters.findIndex(waiter => waiter.event === event);
    if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(data);
        return;
    }
    events.push({ event, data });
}

function waitForEvent(event, timeoutMs) {
    const index = events.findIndex(candidate => candidate.event === event);
    if (index >= 0) {
        const [candidate] = events.splice(index, 1);
        return Promise.resolve(candidate.data);
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const waiterIndex = waiters.findIndex(waiter => waiter.timer === timer);
            if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
            reject(new Error(`timed out waiting ${timeoutMs}ms for SIP ${event}`));
        }, timeoutMs);
        waiters.push({ event, resolve, reject, timer });
    });
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
        `o=- ${Date.now()} 1 IN IP4 ${primaryIpv4()}`,
        's=rtc-session-gateway-sip-responder',
        `c=IN IP4 ${primaryIpv4()}`,
        't=0 0',
        `m=audio ${port} RTP/AVP 0 101`,
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:101 telephone-event/8000',
        'a=fmtp:101 0-16',
        'a=sendrecv'
    ].join('\r\n');
}

function taggedToHeader(value, tag) {
    if (!value) return `<sip:unknown@${primaryIpv4()}>;tag=${tag}`;
    if (/;\s*tag=/i.test(value)) return value;
    return `${value};tag=${tag}`;
}

function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    return value;
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

function write(response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
}

function shutdown(code) {
    for (const socket of connections) socket.destroy();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
}
