import assert from 'node:assert/strict';
import test from 'node:test';
import { FirewallReconciler, type FirewallBackend } from '../src/firewall-reconciler';
import type { FirewallSnapshot } from '../src/firewall-contract';

const start = Date.parse('2026-10-06T00:00:00.000Z');
function snapshot(revision = 1, blocks = [{ target: '192.0.2.1', expiresAt: new Date(start + 10000).toISOString() }]): FirewallSnapshot {
    return {
        schemaVersion: 1,
        instanceId: 'owner-a',
        startedAt: new Date(start).toISOString(),
        generatedAt: new Date(start).toISOString(),
        revision,
        blocks,
        allowlist: []
    };
}
class Backend implements FirewallBackend {
    calls: string[] = [];
    fail = false;
    async reset() {
        this.calls.push('reset');
    }
    async add(target: string, ttl: number) {
        if (this.fail) throw new Error('kernel unavailable');
        this.calls.push('add ' + target + ' ' + ttl);
    }
    async remove(target: string) {
        this.calls.push('remove ' + target);
    }
}

test('full replacement applies, preserves unchanged TTL, refreshes changed TTL and unblocks', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    reconciler.accept(snapshot());
    await reconciler.reconcile();
    await reconciler.reconcile();
    assert.deepEqual(backend.calls, ['reset', 'add 192.0.2.1 10']);
    reconciler.accept(snapshot(2, [{ target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() }]));
    await reconciler.reconcile();
    assert.deepEqual(backend.calls.slice(-2), ['remove 192.0.2.1', 'add 192.0.2.1 20']);
    reconciler.accept(snapshot(3, []));
    await reconciler.reconcile();
    assert.equal(reconciler.state.active, 0);
    assert.equal(reconciler.state.appliedRevision, 3);
});

test('allow overlap and expired snapshots cannot enter kernel or refresh TTL', async () => {
    let now = start;
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => now);
    reconciler.accept({ ...snapshot(), allowlist: ['192.0.2.0/24'] });
    await reconciler.reconcile();
    assert.deepEqual(backend.calls, ['reset']);
    reconciler.accept(snapshot(2));
    await reconciler.reconcile();
    now += 10000;
    await reconciler.reconcile();
    assert.equal(backend.calls.at(-1), 'remove 192.0.2.1');
    const count = backend.calls.length;
    await reconciler.reconcile();
    assert.equal(backend.calls.length, count);
});

test('invalid/stale/reordered/conflicting snapshots retain last valid state and fence former owner', async () => {
    let now = start;
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => now);
    reconciler.accept(snapshot(2));
    assert.throws(() => reconciler.accept(snapshot(1)));
    assert.throws(() => reconciler.accept(snapshot(2, [])));
    assert.throws(() =>
        reconciler.accept({
            ...snapshot(3),
            blocks: [{ target: 'bad', expiresAt: new Date(start).toISOString() }]
        })
    );
    await reconciler.reconcile();
    assert.equal(reconciler.state.active, 1);
    now++;
    reconciler.accept({
        ...snapshot(0, []),
        instanceId: 'owner-b',
        startedAt: new Date(now).toISOString(),
        generatedAt: new Date(now).toISOString()
    });
    assert.throws(() => reconciler.accept(snapshot(100)));
    await reconciler.reconcile();
    assert.equal(reconciler.state.active, 0);
    assert.equal(reconciler.state.instanceId, 'owner-b');
});

test('failed re-add self-heals and a fresh process resets only its backend before rebuilding', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    reconciler.accept(snapshot());
    await reconciler.reconcile();
    backend.fail = true;
    reconciler.accept(snapshot(2, [{ target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() }]));
    await assert.rejects(reconciler.reconcile());
    assert.equal(reconciler.state.active, 0);
    assert.equal(reconciler.state.appliedRevision, 1);
    assert.equal(reconciler.state.lastError, 'kernel unavailable');
    backend.fail = false;
    await reconciler.reconcile();
    assert.equal(reconciler.state.active, 1);
    assert.equal(reconciler.state.appliedRevision, 2);
    assert.equal(reconciler.state.lastError, undefined);
    const restarted = new FirewallReconciler(backend, () => start);
    restarted.accept(snapshot(3, []));
    await restarted.reconcile();
    assert.equal(backend.calls.at(-1), 'reset');
});

test('concurrent snapshots serialize kernel operations and converge to latest view', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
        release = resolve;
    });
    const backend = new Backend();
    backend.add = async target => {
        backend.calls.push('begin ' + target);
        await barrier;
        backend.calls.push('end ' + target);
    };
    const reconciler = new FirewallReconciler(backend, () => start);
    reconciler.accept(snapshot());
    const applying = reconciler.reconcile();
    await new Promise(resolve => setImmediate(resolve));
    reconciler.accept(snapshot(2, []));
    const next = reconciler.reconcile();
    release();
    await Promise.all([applying, next]);
    assert.deepEqual(backend.calls, ['reset', 'begin 192.0.2.1', 'end 192.0.2.1', 'remove 192.0.2.1']);
    assert.equal(reconciler.state.active, 0);
});

test('overlapping manual CIDR and automatic host converge without native interval conflicts', async () => {
    let now = start;
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => now);
    reconciler.accept(
        snapshot(1, [
            { target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() },
            { target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }
        ])
    );
    await reconciler.reconcile();
    assert.deepEqual(backend.calls, ['reset', 'add 192.0.2.0/24 10']);
    now += 10000;
    await reconciler.reconcile();
    assert.deepEqual(backend.calls.slice(-2), ['remove 192.0.2.0/24', 'add 192.0.2.1 10']);
});

test('one failing target is isolated: others apply, unrelated entries are not removed, pass reports failure', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expires = new Date(start + 10000).toISOString();
    reconciler.accept(snapshot(1, [{ target: '192.0.2.1', expiresAt: expires }]));
    await reconciler.reconcile();
    const originalAdd = backend.add.bind(backend);
    backend.add = async (target, ttl) => {
        if (target === '198.51.100.0/24') throw new Error('rejected');
        return originalAdd(target, ttl);
    };
    reconciler.accept(
        snapshot(2, [
            { target: '192.0.2.1', expiresAt: expires },
            { target: '198.51.100.0/24', expiresAt: expires },
            { target: '203.0.113.5', expiresAt: expires }
        ])
    );
    await assert.rejects(reconciler.reconcile(), /rejected/);
    assert.ok(backend.calls.includes('add 203.0.113.5 10'));
    assert.ok(!backend.calls.some(call => call.startsWith('remove')));
    assert.equal(reconciler.state.active, 2);
    assert.equal(reconciler.state.lastError, 'rejected');
    assert.equal(reconciler.state.appliedRevision, 1);
});

test('a failing removal leaves the entry mirrored and still applies other changes', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expires = new Date(start + 10000).toISOString();
    reconciler.accept(snapshot(1, [{ target: '192.0.2.1', expiresAt: expires }]));
    await reconciler.reconcile();
    backend.remove = async target => {
        backend.calls.push('remove ' + target);
        throw new Error('no remove');
    };
    reconciler.accept(snapshot(2, [{ target: '203.0.113.5', expiresAt: expires }]));
    await assert.rejects(reconciler.reconcile());
    assert.ok(backend.calls.includes('add 203.0.113.5 10'));
    assert.equal(reconciler.state.active, 2);
});

test('loopback and sidecar-protected CIDRs are never installed, regardless of snapshot allowlist', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start, ['10.0.0.0/8']);
    const expires = new Date(start + 10000).toISOString();
    reconciler.accept(
        snapshot(1, [
            { target: '127.0.0.1', expiresAt: expires },
            { target: '10.1.2.3', expiresAt: expires },
            { target: '::1', expiresAt: expires },
            { target: '192.0.2.1', expiresAt: expires }
        ])
    );
    await reconciler.reconcile();
    assert.deepEqual(backend.calls, ['reset', 'add 192.0.2.1 10']);
});

test('snapshots with /0 or overly broad block targets are rejected', () => {
    const expires = new Date(start + 10000).toISOString();
    for (const target of ['0.0.0.0/0', '::ffff:0:0/96', '::/0', '128.0.0.0/7', '8000::/15'])
        assert.throws(() => new FirewallReconciler(new Backend(), () => start).accept(snapshot(1, [{ target, expiresAt: expires }])), /too broad/);
    assert.doesNotThrow(() => new FirewallReconciler(new Backend(), () => start).accept({ ...snapshot(1, []), allowlist: ['0.0.0.0/0'] }));
});

test('a silent owner whose last snapshot is stale can be replaced by an instance with an earlier startedAt', () => {
    let now = start;
    const reconciler = new FirewallReconciler(new Backend(), () => now);
    reconciler.accept(snapshot(1));
    now = start + 30_000;
    const earlier = (): FirewallSnapshot => ({
        ...snapshot(0, []),
        instanceId: 'owner-b',
        startedAt: new Date(start - 1000).toISOString(),
        generatedAt: new Date(now).toISOString()
    });
    assert.throws(() => reconciler.accept(earlier()), /Superseded/);
    now = start + 61_000;
    reconciler.accept(earlier());
    assert.equal(reconciler.state.instanceId, 'owner-b');
});
