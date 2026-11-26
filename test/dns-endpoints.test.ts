import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config';
import { resolveControlEndpoints, resolveMediaAlias } from '../src/dns-endpoints';
import { MediaServerManager } from '../src/media-server-manager';

const suffix = '.voice.svc.pods.example.test';
const primary = 'pool-east' + suffix;
const standby = 'pool-west' + suffix;
const fileService = 'recording-owners' + suffix;
const alias = 'active-media' + suffix;
const primaryId = 'east-media-0';
const standbyId = 'west-media-0';

test('discovery Service names and endpoint identity come from deployment configuration', () => {
    const env = {
        CONTROL_AUTH_MODE: 'none',
        SIPBRIDGE_DNS_SERVICE: 'signaling-workers' + suffix,
        SIPBRIDGE_DNS_ENDPOINT_ID: 'edge-a',
        SIPBRIDGE_TLS_SERVERNAME: 'edge-a.example.test',
        RTPBRIDGE_DNS_ALIAS: alias,
        RTPBRIDGE_DNS_FILES: fileService + '.',
        RTPBRIDGE_TLS_SERVERNAME: 'media.example.test',
        RTPBRIDGE_TLS_CA_FILE: '/test/media-ca',
        RTPBRIDGE_AUTH_HMAC_SECRET_FILE: '/test/media-hmac',
        RTPBRIDGE_DNS_LEGACY_PREFIXES_JSON: '["old-"]'
    };
    const config = loadConfig(env);
    assert.equal(config.SIPBRIDGE_DNS_SERVICE, env.SIPBRIDGE_DNS_SERVICE);
    assert.equal(config.SIPBRIDGE_DNS_ENDPOINT_ID, 'edge-a');
    assert.equal(config.RTPBRIDGE_DNS_ALIAS, alias);
    assert.equal(config.RTPBRIDGE_DNS_FILES, fileService);
    assert.deepEqual(config.RTPBRIDGE_DNS_LEGACY_PREFIXES, ['old-']);
    assert.throws(() => loadConfig({ ...env, RTPBRIDGE_DNS_FILES: 'files.example.test' }), /Invalid discovery Service name/);
    assert.throws(() => loadConfig({ ...env, RTPBRIDGE_DNS_FILES: alias }), /separate allocation and file Services/);
    assert.throws(() => loadConfig({ ...env, RTPBRIDGE_DNS_LEGACY_PREFIXES_JSON: 'null' }), /valid ID prefixes/);
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
            RTPBRIDGE_DNS_LEGACY_SITE: 'east',
            RTPBRIDGE_DNS_LEGACY_PREFIXES: ['old-'],
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
        assert.equal((await manager.resolveBackend('media-0')).serverName, 'control.example.test');
        assert.equal((await manager.resolveBackend('old-media-0')).httpUrl, 'https://172.18.8.209:9100');
        await assert.rejects(() => manager.resolveBackend('unconfigured-media-0'));
        target = 'pool-all.other.svc.pods.example.test';
        await assert.rejects(() => manager.pickBackendForCall('invalid'));
        assert.equal(await manager.pickBackendForCall('active'), primaryId);
    } finally {
        manager.destroy();
    }
});

test('DNS ignores foreign targets and rejects ambiguous control coordinates', async () => {
    const resolver = {
        resolveCname: async () => [fileService + '.'],
        resolveSrv: async () => [
            { name: `${primaryId}.${primary}`, port: 9100 },
            { name: `${primaryId}.${primary}`, port: 9101 },
            { name: 'invalid.example.test', port: 9100 }
        ],
        resolve4: async () => ['172.18.8.205']
    };
    assert.deepEqual(await resolveControlEndpoints(primary, resolver), []);
    await assert.rejects(() => resolveMediaAlias(alias, resolver, fileService), /File discovery cannot admit new media sessions/);
    const exportedFileService = { ...resolver, resolveCname: async () => ['recording-owners.voice.svc.peers.example.test'] };
    await assert.rejects(() => resolveMediaAlias(alias, exportedFileService, fileService), /File discovery cannot admit new media sessions/);
});

test('cluster-qualified SRV targets keep the endpoint ID and resolve the complete target', async () => {
    const target = `${primaryId}.east-cluster.${primary}`;
    const queries: string[] = [];
    const resolver = {
        resolveCname: async () => [primary],
        resolveSrv: async () => [
            { name: target + '.', port: 9100 },
            { name: `${standbyId}.east-cluster.${primary}`, port: 9100 },
            { name: `${standbyId}.west-cluster.${primary}`, port: 9100 },
            { name: `invalid.east-cluster.${standby}`, port: 9100 },
            { name: `invalid.nested.east-cluster.${primary}`, port: 9100 }
        ],
        resolve4: async (name: string) => {
            queries.push(name);
            return ['172.18.8.205'];
        }
    };
    assert.deepEqual(await resolveMediaAlias(alias, resolver, fileService), [{ name: primaryId, host: '172.18.8.205', port: 9100 }]);
    assert.deepEqual(queries, [target]);
});
