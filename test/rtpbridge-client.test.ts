import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketServer } from 'ws';

import { RtpbridgeClient } from '../src/rtpbridge-client';

test('malformed or reserved-name rtpbridge frames never throw out of the message handler', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => wss.once('listening', resolve));
    const port = (wss.address() as { port: number }).port;
    const client = new RtpbridgeClient({ url: `ws://127.0.0.1:${port}` } as never);
    try {
        await (client as unknown as { ready: Promise<void> }).ready;
        const seen: unknown[] = [];
        client.on('rtpbridge.event', e => seen.push(e));
        const handle = (client as unknown as { handleMessage(raw: string): void }).handleMessage.bind(client);
        for (const frame of ['{"event":"error","data":{}}', 'null', '{"event":5}', '[]', '5', '{"event":"x","data":null}']) {
            assert.doesNotThrow(() => handle(frame), frame);
        }
        assert.equal(client.listenerCount('error'), 0);
        assert.ok(seen.length >= 1);
    } finally {
        client.close();
        wss.close();
    }
});

test('hostile reply and deeply nested event frames are contained; matching pending RPC is rejected', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => wss.once('listening', resolve));
    const port = (wss.address() as { port: number }).port;
    const client = new RtpbridgeClient({ url: `ws://127.0.0.1:${port}`, timeoutMs: 5000 } as never);
    try {
        await (client as unknown as { ready: Promise<void> }).ready;
        const internals = client as unknown as {
            handleMessage(raw: string): void;
            pending: Map<string, unknown>;
        };
        const addPending = (id: string) =>
            new Promise<unknown>((resolve, reject) => {
                internals.pending.set(id, { resolve, reject, timer: setTimeout(() => {}, 5000), method: 'x' });
            });

        // error.message that throws on stringification (unserializable via JSON too)
        const p1 = addPending('a');
        const hostile = '{"id":"a","error":{"message":{"toString":1},"code":5}}';
        assert.doesNotThrow(() => internals.handleMessage(hostile));
        await assert.rejects(p1, /rtpbridge/);

        // Object.create(null)-like: non-string message, object without toString after parse is impossible via JSON, so
        // also exercise the throwing-getter path directly through a Proxy-backed frame.
        const p2 = addPending('b');
        const origParse = JSON.parse;
        JSON.parse = () => ({
            id: 'b',
            error: {
                get message(): string {
                    throw 1;
                }
            }
        });
        try {
            assert.doesNotThrow(() => internals.handleMessage('{}'));
        } finally {
            JSON.parse = origParse;
        }
        await assert.rejects(p2, /rtpbridge/);

        // Over-deep result for a pending RPC -> rejected with protocol error, not left to time out.
        const p3 = addPending('c');
        const deep = '['.repeat(10_000) + ']'.repeat(10_000);
        assert.doesNotThrow(() => internals.handleMessage(`{"id":"c","result":${deep}}`));
        await assert.rejects(p3, /protocol error/);

        // Over-deep event -> no throw, no emit.
        const seen: unknown[] = [];
        client.on('rtpbridge.event', e => seen.push(e));
        assert.doesNotThrow(() => internals.handleMessage(`{"event":"x","data":${deep}}`));
        assert.equal(seen.length, 0);
    } finally {
        client.close();
        wss.close();
    }
});

test('startRecording rejects a reply without a usable recording id as protocol_error', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => wss.once('listening', resolve));
    const port = (wss.address() as { port: number }).port;
    const client = new RtpbridgeClient({ url: `ws://127.0.0.1:${port}` } as never);
    try {
        await (client as unknown as { ready: Promise<void> }).ready;
        const internals = client as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> };
        for (const reply of [{}, { recordingId: '' }, { recordingId: 5 }]) {
            internals.sendRequest = async () => reply;
            await assert.rejects(client.startRecording('s', { filePath: 'a.pcap' }), (err: { code?: string }) => err.code === 'protocol_error');
        }
        internals.sendRequest = async () => ({ recordingId: 'rec-1' });
        assert.deepEqual(await client.startRecording('s', { filePath: 'a.pcap' }), { recordingId: 'rec-1' });
    } finally {
        client.close();
        wss.close();
    }
});

test('stopRecording and listSessionRecordings validate replies against the rtpbridge protocol as protocol_error', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => wss.once('listening', resolve));
    const port = (wss.address() as { port: number }).port;
    const client = new RtpbridgeClient({ url: `ws://127.0.0.1:${port}` } as never);
    try {
        await (client as unknown as { ready: Promise<void> }).ready;
        const internals = client as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> };
        const protocolError = (err: { code?: string }) => err.code === 'protocol_error';
        const goodStop = { filePath: '/r/a.pcap', durationMs: 5, packets: 3, droppedPackets: 0, stoppedAtEpochMs: 10 };
        for (const reply of [
            {},
            null,
            { ...goodStop, filePath: 1 },
            { ...goodStop, durationMs: '5' },
            { ...goodStop, packets: undefined },
            { ...goodStop, droppedPackets: -1 },
            { ...goodStop, stoppedAtEpochMs: 1.5 }
        ]) {
            internals.sendRequest = async () => reply;
            await assert.rejects(client.stopRecording('rec-1'), protocolError);
        }
        internals.sendRequest = async () => goodStop;
        assert.deepEqual(await client.stopRecording('rec-1'), goodStop);

        const entry = { recordingId: 'rec-1', filePath: '/r/a.pcap', state: 'active' };
        const badLists = [
            {},
            { recordings: [{ ...entry, state: undefined }] },
            { recordings: [{ ...entry, state: 'paused' }] },
            { recordings: [{ ...entry, recordingId: 5 }] },
            { recordings: [{ ...entry, filePath: undefined }] },
            { recordings: [{ ...entry, endpointId: 5 }] },
            { recordings: [null] }
        ];
        for (const reply of badLists) {
            internals.sendRequest = async () => reply;
            await assert.rejects(client.listSessionRecordings(), protocolError);
        }
        internals.sendRequest = async () => ({ recordings: [entry, { ...entry, recordingId: 'rec-2', endpointId: null, state: 'stopped' }] });
        const recordings = await client.listSessionRecordings();
        assert.equal(recordings.length, 2);
    } finally {
        client.close();
        wss.close();
    }
});
