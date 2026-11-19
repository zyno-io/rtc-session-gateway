import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { CallRegistry } from '../src/call-registry';
import { createHttpApp, type GatewayController } from '../src/http-server';
import { loadFirewallConfig, SipFirewall } from '../src/sip-firewall';
import { FirewallReconciler } from '../src/firewall-reconciler';
import { createFirewallHandler } from '../src/firewall-receiver';
import { postFirewallSnapshot } from '../src/firewall-publisher';

const config = (overrides = {}) => ({
    ...loadFirewallConfig({
        SIP_FIREWALL_MODE: 'enforce',
        SIP_FIREWALL_THRESHOLD: '2',
        SIP_FIREWALL_ADMIN_TOKEN: 'admin',
        SIP_FIREWALL_SNAPSHOT_TOKEN: 'reader'
    }),
    ...overrides
});
const fixedNow = Date.now();
const gateway = { isConnected: true } as GatewayController;

async function listen(listener: http.RequestListener) {
    const server = http.createServer(listener);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return { server, root: `http://127.0.0.1:${address.port}` };
}
test('operator and snapshot credentials stay separate from unauthenticated control', async () => {
    const firewall = new SipFirewall(config(), () => fixedNow);
    const api = await listen(
        createHttpApp(
            new CallRegistry(),
            gateway,
            undefined,
            { CONTROL_AUTH_MODE: 'none' },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            firewall
        )
    );
    const request = (path: string, token?: string, body?: unknown, method = body ? 'POST' : 'GET') =>
        fetch(api.root + path, {
            method,
            headers: {
                ...(token ? { authorization: 'Bearer ' + token } : {}),
                'content-type': 'application/json'
            },
            body: body ? JSON.stringify(body) : undefined
        });
    try {
        const missing = await request('/firewall/status');
        assert.equal(missing.status, 401);
        const readonly = await request('/firewall/blocks', 'reader', {
            target: '192.0.2.1',
            ttlSeconds: 10,
            reason: 'test'
        });
        assert.equal(readonly.status, 401);
        const ban = await request('/firewall/blocks', 'admin', {
            target: '192.0.2.1',
            ttlSeconds: 10,
            reason: 'test'
        });
        assert.equal(ban.status, 200);
        const snapshot = await request('/firewall/snapshot', 'reader');
        assert.equal(snapshot.status, 200);
        const listing = await request('/firewall/blocks?limit=1', 'admin');
        const result = await listing.json();
        assert.equal(result.total, 1);
        const badPagination = await request('/firewall/blocks?limit=1001', 'admin');
        assert.equal(badPagination.status, 400);
        const unblock = await request('/firewall/blocks?target=192.0.2.1', 'admin', undefined, 'DELETE');
        assert.equal(unblock.status, 200);
        assert.equal(firewall.shouldReject('192.0.2.1'), false);
    } finally {
        api.server.closeAllConnections();
        api.server.close();
    }
});

test('sidecar accepts bounded authenticated full snapshots and publisher failures leave installed state', async () => {
    const calls: string[] = [];
    const reconciler = new FirewallReconciler({
        reset: async () => {
            calls.push('reset');
        },
        add: async target => {
            calls.push(target);
        },
        remove: async () => {}
    });
    const api = await listen(createFirewallHandler(reconciler, 'publisher'));
    const firewall = new SipFirewall(config(), () => fixedNow);
    firewall.ban('192.0.2.1', 10, 'test');
    try {
        await assert.rejects(postFirewallSnapshot(api.root + '/v1/snapshot', 'wrong', firewall.snapshot()));
        await postFirewallSnapshot(api.root + '/v1/snapshot', 'publisher', firewall.snapshot());
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, ['reset', '192.0.2.1']);
        await assert.rejects(postFirewallSnapshot(api.root + '/v1/snapshot', 'publisher', { bad: true }));
        assert.equal(reconciler.state.active, 1);
        const badType = await fetch(api.root + '/v1/snapshot', {
            method: 'POST',
            headers: { authorization: 'Bearer publisher' },
            body: '{}'
        });
        assert.equal(badType.status, 415);
        const oversized = await fetch(api.root + '/v1/snapshot', {
            method: 'POST',
            headers: { authorization: 'Bearer publisher', 'content-type': 'application/json' },
            body: ' '.repeat(2 * 1024 * 1024 + 1)
        });
        assert.equal(oversized.status, 413);
    } finally {
        api.server.closeAllConnections();
        api.server.close();
    }
});

test('firewall path aliases never reach a route under another credential', async () => {
    for (const snapshotToken of ['reader', undefined]) {
        const firewall = new SipFirewall({ ...config(), snapshotToken }, () => fixedNow);
        const api = await listen(
            createHttpApp(
                new CallRegistry(),
                gateway,
                undefined,
                { CONTROL_AUTH_MODE: 'none' },
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                firewall
            )
        );
        const call = (path: string, token?: string, method = 'GET') =>
            fetch(api.root + path, { method, headers: token ? { authorization: 'Bearer ' + token } : {} });
        try {
            for (const [path, method] of [
                ['/firewall/SNAPSHOT', 'GET'],
                ['/firewall/snapshot/', 'GET'],
                ['/firewall/snapshot', 'HEAD'],
                ['/firewall/Status', 'GET'],
                ['/firewall/nothing', 'GET']
            ]) {
                const response = await call(path, 'admin', method);
                assert.notEqual(response.status, 200, `${method} ${path}`);
                assert.equal(response.status, 401, `${method} ${path}`);
            }
            if (snapshotToken) assert.equal((await call('/firewall/snapshot', 'reader')).status, 200);
            assert.equal((await call('/firewall/snapshot', 'admin')).status, 401);
            assert.equal((await call('/firewall/status', 'admin')).status, 200);
            assert.equal((await call('/firewall/blocks', 'admin')).status, 200);
        } finally {
            api.server.closeAllConnections();
            api.server.close();
        }
    }
});
