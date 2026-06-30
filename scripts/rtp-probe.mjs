#!/usr/bin/env node

import dgram from 'node:dgram';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import process from 'node:process';
import readline from 'node:readline';

const peers = new Map();
let audioServer;

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
        case 'peer.create':
            return createPeer();
        case 'peer.send':
            return sendPackets(requiredPeer(params.peerId), params);
        case 'peer.sendDtmf':
            return sendDtmf(requiredPeer(params.peerId), params);
        case 'peer.wait':
            return waitForPacket(requiredPeer(params.peerId), params.timeoutMs ?? 5_000);
        case 'peer.close':
            closePeer(params.peerId);
            return { ok: true };
        case 'audio.start':
            return startAudioServer();
        case 'audio.close':
            await closeAudioServer();
            return { ok: true };
        case 'ping':
            return { ok: true, ip: primaryIpv4() };
        case 'shutdown':
            setImmediate(() => shutdown(0));
            return { ok: true };
        default:
            throw new Error(`unknown probe method ${request.method}`);
    }
}

async function createPeer() {
    const socket = dgram.createSocket('udp4');
    const peer = {
        peerId: randomUUID(),
        socket,
        received: [],
        waiters: [],
        sequence: Math.floor(Math.random() * 65535),
        timestamp: Math.floor(Math.random() * 0xffffffff),
        ssrc: Math.floor(Math.random() * 0xffffffff)
    };
    socket.on('message', data => receive(peer, data));
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '0.0.0.0', () => {
            socket.off('error', reject);
            resolve();
        });
    });
    peers.set(peer.peerId, peer);
    return {
        peerId: peer.peerId,
        ip: primaryIpv4(),
        port: socket.address().port
    };
}

async function sendPackets(peer, params) {
    const host = requiredString(params.host, 'host');
    const port = requiredPort(params.port, 'port');
    const count = Number(params.count ?? 1);
    if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
    for (let i = 0; i < count; i++) {
        await sendPacket(peer, host, port, params);
        await sleep(Number(params.intervalMs ?? 20));
    }
    return { sent: count };
}

async function sendDtmf(peer, params) {
    const host = requiredString(params.host, 'host');
    const port = requiredPort(params.port, 'port');
    const digit = requiredString(params.digit, 'digit').toUpperCase();
    const event = dtmfEventCode(digit);
    const payloadType = Number(params.payloadType ?? 101);
    const durationMs = Number(params.durationMs ?? 160);
    const clockRate = Number(params.clockRate ?? 8000);
    if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) throw new Error('payloadType must be 0-127');
    if (!Number.isInteger(durationMs) || durationMs < 40 || durationMs > 10_000) throw new Error('durationMs must be 40-10000');

    const totalDuration = Math.floor(durationMs * clockRate / 1000);
    const timestamp = peer.timestamp >>> 0;
    const volume = 10;
    const packets = [
        { marker: true, end: false, duration: Math.floor(totalDuration / 3) },
        { marker: false, end: false, duration: Math.floor(totalDuration * 2 / 3) },
        { marker: false, end: false, duration: totalDuration },
        { marker: false, end: true, duration: totalDuration },
        { marker: false, end: true, duration: totalDuration },
        { marker: false, end: true, duration: totalDuration }
    ];

    for (const item of packets) {
        await sendRaw(peer, host, port, buildDtmfPacket(peer, {
            event,
            payloadType,
            marker: item.marker,
            end: item.end,
            duration: item.duration,
            volume,
            timestamp
        }));
        await sleep(Number(params.intervalMs ?? 20));
    }
    peer.timestamp = (timestamp + totalDuration) >>> 0;
    return { sent: packets.length };
}

function sendPacket(peer, host, port, params = {}) {
    return sendRaw(peer, host, port, buildRtpPacket(peer, params));
}

function sendRaw(peer, host, port, packet) {
    return new Promise((resolve, reject) => {
        peer.socket.send(packet, port, host, err => err ? reject(err) : resolve());
    });
}

function buildRtpPacket(peer, params = {}) {
    const packet = Buffer.alloc(12 + 160, 0xff);
    packet[0] = 0x80;
    packet[1] = 0x00;
    packet.writeUInt16BE(peer.sequence++ & 0xffff, 2);
    packet.writeUInt32BE(peer.timestamp >>> 0, 4);
    packet.writeUInt32BE(peer.ssrc >>> 0, 8);
    fillPayload(packet.subarray(12), params.payloadMode, params.payloadByte);
    peer.timestamp = (peer.timestamp + 160) >>> 0;
    return packet;
}

function buildDtmfPacket(peer, params) {
    const packet = Buffer.alloc(16);
    packet[0] = 0x80;
    packet[1] = (params.marker ? 0x80 : 0x00) | params.payloadType;
    packet.writeUInt16BE(peer.sequence++ & 0xffff, 2);
    packet.writeUInt32BE(params.timestamp >>> 0, 4);
    packet.writeUInt32BE(peer.ssrc >>> 0, 8);
    packet[12] = params.event;
    packet[13] = (params.end ? 0x80 : 0x00) | params.volume;
    packet.writeUInt16BE(params.duration & 0xffff, 14);
    return packet;
}

function fillPayload(payload, mode = 'silence', payloadByte) {
    if (payloadByte !== undefined) {
        payload.fill(Number(payloadByte) & 0xff);
        return;
    }
    if (mode === 'noise') {
        for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(Math.random() * 256);
        return;
    }
    payload.fill(0xff);
}

function dtmfEventCode(digit) {
    if (/^[0-9]$/.test(digit)) return Number(digit);
    if (digit === '*') return 10;
    if (digit === '#') return 11;
    const index = ['A', 'B', 'C', 'D'].indexOf(digit);
    if (index >= 0) return 12 + index;
    throw new Error('digit must be one of 0-9, *, #, A-D');
}

function receive(peer, packet) {
    const sample = {
        length: packet.length,
        payloadType: packet.length > 1 ? packet[1] & 0x7f : undefined,
        sequence: packet.length > 3 ? packet.readUInt16BE(2) : undefined
    };
    const waiter = peer.waiters.shift();
    if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(sample);
        return;
    }
    peer.received.push(sample);
}

function waitForPacket(peer, timeoutMs) {
    const packet = peer.received.shift();
    if (packet) return Promise.resolve(packet);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            peer.waiters = peer.waiters.filter(waiter => waiter.timer !== timer);
            reject(new Error(`timed out waiting ${timeoutMs}ms for RTP packet`));
        }, timeoutMs);
        peer.waiters.push({ resolve, reject, timer });
    });
}

async function startAudioServer() {
    if (audioServer) return audioServer.info;
    const wav = createToneWav();
    const server = http.createServer((req, res) => {
        if (req.url !== '/tone.wav' && req.url !== '/message.wav') {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': wav.length
        });
        res.end(wav);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const info = {
        url: `http://${primaryIpv4()}:${server.address().port}/tone.wav`,
        messageUrl: `http://${primaryIpv4()}:${server.address().port}/message.wav`
    };
    audioServer = { server, info };
    return info;
}

async function closeAudioServer() {
    if (!audioServer) return;
    const { server } = audioServer;
    audioServer = undefined;
    await new Promise(resolve => server.close(resolve));
}

function createToneWav() {
    const sampleRate = 8000;
    const durationMs = 300;
    const samples = Math.floor(sampleRate * durationMs / 1000);
    const dataSize = samples * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
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
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples; i++) {
        const sample = Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 14000);
        buffer.writeInt16LE(sample, 44 + i * 2);
    }
    return buffer;
}

function closePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    for (const waiter of peer.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('RTP peer closed'));
    }
    peer.socket.close();
}

function requiredPeer(peerId) {
    const peer = peers.get(requiredString(peerId, 'peerId'));
    if (!peer) throw new Error(`unknown peer ${peerId}`);
    return peer;
}

function requiredString(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
    return value;
}

function requiredPort(value, field) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${field} must be a UDP port`);
    return port;
}

function primaryIpv4() {
    for (const iface of Object.values(networkInterfaces())) {
        for (const address of iface ?? []) {
            if (address.family === 'IPv4' && !address.internal) return address.address;
        }
    }
    return '127.0.0.1';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function shutdown(code) {
    for (const peerId of [...peers.keys()]) closePeer(peerId);
    await closeAudioServer();
    process.exit(code);
}
