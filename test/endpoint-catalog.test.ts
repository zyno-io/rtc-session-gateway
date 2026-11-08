import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileEndpointCatalog, parseEndpointCatalog, parseIceUrls } from '../src/endpoint-catalog';
import { MediaServerManager, MediaBackendNotFoundError, MediaBackendUnavailableError } from '../src/media-server-manager';

function backend(id: string, acceptNew = true) {
    return {
        id,
        acceptNew,
        control: { url: 'wss://10.0.0.1:9100/', tlsServerName: 'control.' + id + '.test' },
        recordings: { url: 'https://10.0.0.1:9200/', tlsServerName: 'recordings.' + id + '.test' },
        turn: { urls: ['turns:turn.example.net:443?transport=tcp'] }
    };
}
function catalog(backends = [backend('a')], validUntil?: string) {
    return {
        schemaVersion: 2,
        signaling: {
            revision: 'a'.repeat(64),
            validUntil: validUntil ?? new Date(Date.now() + 30000).toISOString(),
            backends: []
        },
        media: {
            revision: 'b'.repeat(64),
            validUntil: validUntil ?? new Date(Date.now() + 30000).toISOString(),
            backends
        }
    };
}

test('catalog validates explicit addresses, separate recording ports, TLS identities and ICE URLs', () => {
    const view = parseEndpointCatalog(catalog());
    assert.equal(view.media.backends[0].recordingServerName, 'recordings.a.test');
    assert.equal(view.media.backends[0].httpUrl, 'https://10.0.0.1:9200/');
    assert.deepEqual(view.media.backends[0].turnUrls, ['turns:turn.example.net:443?transport=tcp']);
    for (const invalid of [
        catalog([backend('a'), backend('a')]),
        { ...catalog(), schemaVersion: 1 },
        { ...catalog(), media: { ...catalog().media, validUntil: 'yesterday' } },
        catalog([{ ...backend('a'), acceptNew: undefined } as any]),
        catalog([{ ...backend('a'), control: { url: 'ws://localhost:9100' } } as any]),
        catalog([{ ...backend('a'), control: { url: 'wss://user:pass@localhost/path' } } as any])
    ])
        assert.throws(() => parseEndpointCatalog(invalid));
    assert.throws(() => parseIceUrls(['turns:host:99999']));
    assert.throws(() => parseIceUrls(['https://host/']));
    assert.throws(() => parseIceUrls(['turn:bad..host:3478']));
    assert.deepEqual(parseIceUrls(['turn:[2001:db8::1]:3478?transport=udp']), ['turn:[2001:db8::1]:3478?transport=udp']);
});

test('atomic replacements retain last valid view without extending expiry on broken, missing or stale files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-catalog-'));
    const path = join(directory, 'catalog.json');
    let now = Date.now();
    writeFileSync(path, JSON.stringify(catalog(undefined, new Date(now + 1000).toISOString())));
    const reader = new FileEndpointCatalog(path, false, () => now);
    try {
        assert.equal(reader.status.valid, true);
        writeFileSync(path + '.new', '{broken');
        renameSync(path + '.new', path);
        assert.equal(reader.status.valid, true);
        assert.equal(reader.backends[0].id, 'a');
        rmSync(path);
        now += 1001;
        assert.equal(reader.status.valid, false);
        assert.equal(reader.status.eligibleBackends, 0);
        assert.equal(reader.backends[0].id, 'a');
        writeFileSync(path, JSON.stringify(catalog([], new Date(now + 1000).toISOString())));
        assert.equal(reader.status.valid, true);
        assert.deepEqual(reader.backends, []);
        writeFileSync(path, JSON.stringify(catalog(undefined, new Date(now - 1).toISOString())));
        assert.equal(reader.status.valid, false);
        assert.equal(reader.backends[0].id, 'a');
    } finally {
        reader.destroy();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('catalog selection preserves concurrent call affinity and never falls back for missing or draining identities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-media-'));
    const path = join(directory, 'catalog.json');
    const replace = (value: unknown) => {
        writeFileSync(path + '.new', JSON.stringify(value));
        renameSync(path + '.new', path);
    };
    replace(catalog([backend('a'), backend('b')]));
    const manager = new MediaServerManager(
        {
            RTPBRIDGE_HOST: 'must-not-be-used',
            RTPBRIDGE_PORT: 9100,
            RTPBRIDGE_SRV_PORT_NAME: 'ws',
            RTPBRIDGE_REQUEST_TIMEOUT_MS: 1000,
            RTPBRIDGE_CONNECTION_TIMEOUT_MS: 1000,
            RTC_ENDPOINTS_FILE: path
        },
        {
            resolveSrv: async () => {
                throw new Error('DNS must not run');
            },
            resolve4: async () => {
                throw new Error('DNS must not run');
            }
        }
    );
    try {
        const pins = await Promise.all(Array.from({ length: 10 }, () => manager.pickBackendForCall('call-1')));
        assert.deepEqual(new Set(pins), new Set(['a']));
        const client = await manager.createClient({ callId: 'call-1' });
        assert.equal(client.backendId, 'a');
        assert.deepEqual(client.iceUrls, backend('a').turn.urls);
        client.close();
        replace(catalog([backend('a', false), backend('b')]));
        await assert.rejects(manager.createClient({ callId: 'call-1' }), MediaBackendUnavailableError);
        await assert.rejects(manager.createClient({ backendId: 'missing' }), MediaBackendNotFoundError);
        const recording = await manager.resolveBackend('a');
        assert.equal(recording.httpUrl, 'https://10.0.0.1:9200/');
        const options = manager.getHttpRequestOptions('GET', recording.httpUrl + 'recordings', recording);
        assert.equal(options.httpsAgent.options.servername, 'recordings.a.test');
        replace(catalog([backend('b')]));
        await assert.rejects(manager.createClient({ callId: 'call-1' }), MediaBackendNotFoundError);
        replace(catalog([]));
        await assert.rejects(manager.createClient(), MediaBackendUnavailableError);
        assert.equal(manager.readiness.eligibleBackends, 0);
    } finally {
        manager.destroy();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('media and TURN configuration fail early when required dependencies are omitted', async () => {
    const { loadConfig } = await import('../src/config');
    assert.throws(() => loadConfig({ APP_ENV: 'development', RTPBRIDGE_REQUIRED: 'true' }), /Required media/);
    assert.throws(() => loadConfig({ RECORDING_PATH_PREFIX: '../talk' }), /RECORDING_PATH_PREFIX/);
    assert.equal(loadConfig({ RECORDING_PATH_PREFIX: 'sg_' }).RECORDING_PATH_PREFIX, 'sg_');
    assert.throws(
        () =>
            loadConfig({
                APP_ENV: 'development',
                COTURN_URLS_JSON: '["turns:turn.example.net:443?transport=tcp"]'
            }),
        /COTURN_AUTH_SECRET/
    );
    assert.deepEqual(loadConfig({ APP_ENV: 'development', COTURN_URLS_JSON: '["stun:stun.example.net:3478"]' }).COTURN_URLS, [
        'stun:stun.example.net:3478'
    ]);
});

test('catalog v2 independently expires signaling and media and rejects insecure native metadata', async () => {
    const { FileRtcEndpointCatalog } = await import('../src/endpoint-catalog');
    const directory = mkdtempSync(join(tmpdir(), 'rtc-sections-'));
    const path = join(directory, 'endpoints.json');
    let now = Date.now();
    const value = catalog();
    value.signaling.backends = [
        {
            id: 'sip-core',
            acceptNew: false,
            control: { url: 'wss://10.0.0.2:8443/v1/control', tlsServerName: 'sip.test' }
        }
    ] as never;
    value.signaling.validUntil = new Date(now + 1000).toISOString();
    value.media.validUntil = new Date(now + 5000).toISOString();
    writeFileSync(path, JSON.stringify(value));
    const reader = new FileRtcEndpointCatalog(path, false, () => now);
    try {
        assert.equal(reader.snapshot.signaling.valid, true);
        assert.equal(reader.snapshot.signaling.backends[0].acceptNew, false);
        now += 1001;
        assert.equal(reader.snapshot.signaling.valid, false);
        assert.equal(reader.snapshot.media.valid, true);
        value.signaling.validUntil = new Date(now + 5000).toISOString();
        value.media.validUntil = new Date(now - 1).toISOString();
        writeFileSync(path, JSON.stringify(value));
        assert.equal(reader.snapshot.signaling.valid, true);
        assert.equal(reader.snapshot.media.valid, false);
        for (const control of [
            { url: 'ws://sip.test/v1/control', tlsServerName: 'sip.test' },
            { url: 'wss://sip.test/wrong', tlsServerName: 'sip.test' },
            { url: 'wss://sip.test/v1/control' },
            { url: 'wss://sip.test/v1/control?token=secret', tlsServerName: 'sip.test' }
        ]) {
            const invalid = structuredClone(value);
            (invalid.signaling.backends as any[])[0].control = control;
            assert.throws(() => parseEndpointCatalog(invalid, true));
        }
    } finally {
        reader.destroy();
        rmSync(directory, { recursive: true, force: true });
    }
});
