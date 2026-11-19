import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { AxiosGatewayHttpClient, HttpPostError } from '../src/http-client';

test('Codex 2 (r23): the callback deadline covers response-body consumption (a body streamed forever aborts at the deadline)', async () => {
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"a":"');
        const timer = setInterval(() => res.write('x'), 10);
        res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = (server.address() as { port: number }).port;
        const started = Date.now();
        await assert.rejects(
            new AxiosGatewayHttpClient().postJson(`http://127.0.0.1:${port}/`, {}, 150),
            (err: unknown) => err instanceof HttpPostError && err.code === 'ECONNABORTED'
        );
        assert.ok(Date.now() - started < 1500, 'settled near the deadline');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('a prompt response settles normally and leaves no timer behind', async () => {
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = (server.address() as { port: number }).port;
        assert.deepEqual(await new AxiosGatewayHttpClient().postJson(`http://127.0.0.1:${port}/`, {}, 60000), { ok: true });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('oversized and compressed-bomb owner responses are rejected by maxContentLength; discardBody ignores the body', async () => {
    const { gzipSync } = await import('node:zlib');
    const big = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const bomb = gzipSync(Buffer.concat([Buffer.from('{"a":"'), big, Buffer.from('"}')]));
    const server = createServer((req, res) => {
        if (req.url === '/gzip') {
            res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
            res.end(bomb);
        } else {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(Buffer.concat([Buffer.from('{"a":"'), big, Buffer.from('"}')]));
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = (server.address() as { port: number }).port;
        const client = new AxiosGatewayHttpClient();
        for (const path of ['/plain', '/gzip']) {
            await assert.rejects(client.postJson(`http://127.0.0.1:${port}${path}`, {}, 10000), (err: unknown) => {
                assert.ok(err instanceof HttpPostError);
                assert.match(String((err.cause as Error).message), /maxContentLength/);
                return true;
            });
            assert.equal(await client.postJson(`http://127.0.0.1:${port}${path}`, {}, 10000, { discardBody: true }), undefined);
        }
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

for (const status of [200, 500]) {
    test(`discardBody closes the owner connection promptly for a trickling ${status} response (no leaked socket)`, async () => {
        const closed = Promise.withResolvers<void>();
        const server = createServer((req, res) => {
            req.resume();
            req.on('close', () => undefined);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.write('{"a":"');
            const timer = setInterval(() => res.write('x'), 10);
            req.socket.on('close', () => {
                clearInterval(timer);
                closed.resolve();
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const port = (server.address() as { port: number }).port;
            const post = new AxiosGatewayHttpClient().postJson(`http://127.0.0.1:${port}/`, {}, 30000, { discardBody: true });
            if (status === 200) assert.equal(await post, undefined);
            else await assert.rejects(post, (err: unknown) => err instanceof HttpPostError && err.status === 500);
            await Promise.race([closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('connection leaked')), 2000))]);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
}
