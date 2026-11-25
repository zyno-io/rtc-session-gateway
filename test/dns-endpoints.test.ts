import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config';
import { resolveControlEndpoints, resolveMediaAlias } from '../src/dns-endpoints';
import { MediaServerManager } from '../src/media-server-manager';

const suffix = '.talk.svc.cluster.local';
const primary = 'edge-discovery-rtp-pri' + suffix;
const standby = 'edge-discovery-rtp-fo' + suffix;
const fileService = 'edge-discovery-rtpfiles' + suffix;
const legacyFileService = 'edge-discovery-rtp-files' + suffix;
const alias = 'talk-rtp-active' + suffix;
const primaryId = 'pri-rtpbridge-0';
const standbyId = 'fo-rtpbridge-0';

test('configured recording lookup accepts the current and legacy file Service names only', () => {
    for (const service of [fileService, legacyFileService]) {
        const config = loadConfig({ CONTROL_AUTH_MODE: 'none', RTPBRIDGE_DNS_FILES: service + '.' });
        assert.equal(config.RTPBRIDGE_DNS_FILES, service);
    }
    assert.throws(() => loadConfig({ CONTROL_AUTH_MODE: 'none', RTPBRIDGE_DNS_FILES: primary }), /Invalid file discovery Service name/);
});

test('new allocations follow the DNS alias, calls stay pinned, and file reads resolve the original ordinal again', async () => {
    let target = primary;
    let primaryIp = '172.18.8.205';
    const resolver = {
        resolveCname: async () => [target],
        resolveSrv: async (query: string) => {
            const service = query.slice('_control._tcp.'.length);
            const ids = service === fileService ? [primaryId, standbyId] : [service === primary ? primaryId : standbyId];
            return ids.map(name => ({ name: `${name}.${service}.`, port: 9100 }));
        },
        resolve4: async (name: string) => [name.startsWith(primaryId) ? primaryIp : '172.18.28.205']
    };
    const manager = new MediaServerManager(
        {
            RTPBRIDGE_DNS_ALIAS: alias,
            RTPBRIDGE_DNS_FILES: fileService,
            RTPBRIDGE_DNS_LEGACY_SITE: 'pri',
            RTPBRIDGE_PORT: 9100,
            RTPBRIDGE_SRV_PORT_NAME: 'control',
            RTPBRIDGE_REQUEST_TIMEOUT_MS: 1000,
            RTPBRIDGE_CONNECTION_TIMEOUT_MS: 1000,
            RTPBRIDGE_TLS_SERVERNAME: 'control.example.test'
        },
        resolver
    );
    try {
        assert.equal(await manager.pickBackendForCall('active'), primaryId);
        target = standby;
        primaryIp = '172.18.8.209';
        assert.equal(await manager.pickBackendForCall('active'), primaryId);
        assert.equal(await manager.pickBackendForCall('new'), standbyId);
        assert.equal((await manager.resolveBackend(primaryId)).httpUrl, 'https://172.18.8.209:9100');
        assert.equal((await manager.resolveBackend('rtpbridge-0')).serverName, 'control.example.test');
        assert.equal((await manager.resolveBackend('zc-stg-rtpbridge-0')).httpUrl, 'https://172.18.8.209:9100');
        target = 'edge-discovery-rtp-all.other.svc.cluster.local';
        await assert.rejects(() => manager.pickBackendForCall('invalid'));
        assert.equal(await manager.pickBackendForCall('active'), primaryId);
    } finally {
        manager.destroy();
    }
});

test('DNS ignores foreign targets and rejects ambiguous control coordinates', async () => {
    let target = fileService;
    const resolver = {
        resolveCname: async () => [target],
        resolveSrv: async () => [
            { name: `${primaryId}.${primary}`, port: 9100 },
            { name: `${primaryId}.${primary}`, port: 9101 },
            { name: 'invalid.example.test', port: 9100 }
        ],
        resolve4: async () => ['172.18.8.205']
    };
    assert.deepEqual(await resolveControlEndpoints(primary, resolver), []);
    await assert.rejects(() => resolveMediaAlias(alias, resolver), /File discovery cannot admit new media sessions/);
    target = legacyFileService;
    await assert.rejects(() => resolveMediaAlias(alias, resolver), /File discovery cannot admit new media sessions/);
});
