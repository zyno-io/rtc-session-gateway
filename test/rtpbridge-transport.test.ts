import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { loadConfig } from '../src/config';
import { MediaSessionService } from '../src/media-session-service';
import { MediaServerManager } from '../src/media-server-manager';
import { RtpbridgeTransport } from '../src/rtpbridge-transport';

const secret = 'test-only-rtpbridge-control-secret-12345';
const certPath = join(__dirname, 'fixtures/rtpbridge-cert.pem');
const keyPath = join(__dirname, 'fixtures/rtpbridge-key.pem');

test('gateway uses verified TLS and HMAC for control and every recording HTTP operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-transport-test-'));
    const secretPath = join(directory, 'secret');
    await writeFile(secretPath, `${secret}\r\n`);
    const requests: string[] = [];
    const pcap = Buffer.alloc(24);
    pcap.writeUInt32LE(0xa1b2c3d4, 0);
    pcap.writeUInt16LE(2, 4);
    pcap.writeUInt16LE(4, 6);
    pcap.writeUInt32LE(65535, 16);
    pcap.writeUInt32LE(1, 20);

    const authorized = (method: string, target: string, header: string | undefined) => {
        const match = /^HMAC-SHA256 (\d+):([\w-]+)$/.exec(header ?? '');
        if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 60) return false;
        const expected = createHmac('sha256', secret)
            .update(['rtpbridge-auth-v1', match[1], method, target].join('\n'))
            .digest();
        const actual = Buffer.from(match[2], 'base64url');
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    const server = https.createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (req, res) => {
        if (!authorized(req.method!, req.url!, req.headers.authorization)) {
            res.writeHead(401).end();
            return;
        }
        requests.push(`${req.method} ${req.url}`);
        if (req.url?.startsWith('/recordings?')) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ recordings: ['call 42.pcap'], total: 1 }));
        } else if (req.method === 'DELETE') {
            res.end('{"deleted":true}');
        } else if (req.url === '/recordings/redirect.pcap') {
            res.writeHead(302, { location: '/recordings/call%2042.pcap' }).end();
        } else {
            res.end(pcap);
        }
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        if (!authorized(req.method!, req.url!, req.headers.authorization)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        requests.push(`WS ${req.url}`);
        wss.handleUpgrade(req, socket, head, ws => {
            ws.on('message', data => {
                const request = JSON.parse(data.toString());
                const result = request.method === 'session.create' ? { session_id: 'session-1' } : {};
                ws.send(JSON.stringify({ id: request.id, result }));
            });
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const config = loadConfig({
        CONTROL_AUTH_MODE: 'none',
        RTPBRIDGE_HOST: '127.0.0.1',
        RTPBRIDGE_PORT: String(port),
        RTPBRIDGE_TLS: 'true',
        RTPBRIDGE_AUTH_HMAC_SECRET_FILE: secretPath,
        RTPBRIDGE_TLS_CA_FILE: certPath,
        RTPBRIDGE_TLS_SERVERNAME: 'rtpbridge.test'
    });
    const manager = new MediaServerManager(config);
    const service = new MediaSessionService(manager, '/recordings');
    try {
        const session = await service.createSession();
        assert.equal(session.sessionId, 'session-1');
        const listed = await service.listRecordings({ startsWith: 'call ' });
        assert.equal(listed.recordings[0].path, 'call 42.pcap');
        const download = await service.downloadRecording('127.0.0.1', 'call 42.pcap');
        const downloaded = await readStream(download.stream);
        assert.deepEqual(downloaded, pcap);
        const merged = await service.mergeRecordings([{ backendId: '127.0.0.1', path: 'call 42.pcap' }]);
        const mergedBytes = await readStream(merged.stream);
        assert.deepEqual(mergedBytes, pcap);
        await service.deleteRecording('127.0.0.1', 'call 42.pcap');
        assert.deepEqual(requests, [
            'WS /',
            'GET /recordings?startsWith=call%20&skip=0&limit=1000',
            'GET /recordings/call%2042.pcap',
            'GET /recordings/call%2042.pcap',
            'DELETE /recordings/call%2042.pcap'
        ]);
        const redirect = await service.downloadRecording('127.0.0.1', 'redirect.pcap');
        await readStream(redirect.stream);
        assert.equal(redirect.status, 302);
        assert.equal(requests.at(-1), 'GET /recordings/redirect.pcap');

        const discovered = new MediaServerManager(
            { ...config, RTPBRIDGE_HOST: 'rtpbridge.test', RTPBRIDGE_TLS_SERVERNAME: undefined },
            { resolveSrv: async () => [], resolve4: async () => ['127.0.0.1'] }
        );
        try {
            const client = await discovered.createClient();
            const sessionId = await client.createSession();
            assert.equal(sessionId, 'session-1');
            client.close();
            const discoveredService = new MediaSessionService(discovered);
            const discoveredList = await discoveredService.listRecordings();
            assert.equal(discoveredList.total, 1);
        } finally {
            discovered.destroy();
        }

        const unsigned = new MediaServerManager({ ...config, RTPBRIDGE_AUTH_HMAC_SECRET_FILE: undefined });
        try {
            const client = await unsigned.createClient();
            await assert.rejects(client.createSession(), /401/);
            client.close();
            const unsignedService = new MediaSessionService(unsigned);
            await assert.rejects(unsignedService.listRecordings(), error => (error as { statusCode: number }).statusCode === 401);
        } finally {
            unsigned.destroy();
        }
        const untrusted = new MediaServerManager({ ...config, RTPBRIDGE_TLS_CA_FILE: undefined });
        try {
            const client = await untrusted.createClient();
            await assert.rejects(client.createSession(), /self.signed certificate/);
            client.close();
        } finally {
            untrusted.destroy();
        }
    } finally {
        for (const session of service.list()) await service.destroySession(session.sessionId);
        manager.destroy();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});

test('rtpbridge transport rejects short HMAC keys and invalid TLS settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-secret-test-'));
    const secretPath = join(directory, 'secret');
    try {
        await writeFile(secretPath, 'too short\n');
        assert.throws(() => new RtpbridgeTransport({ hmacSecretFile: secretPath }), /at least 32 bytes/);
        assert.throws(() => loadConfig({ RTPBRIDGE_TLS: 'yes' }), /RTPBRIDGE_TLS must be true or false/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

async function readStream(stream: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}
