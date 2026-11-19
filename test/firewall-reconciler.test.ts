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
    // The refresh add and the old-element restore both fail.
    assert.match(reconciler.state.lastError!, /firewall operations failed: 192\.0\.2\.1/);
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

test('a covering range whose add keeps failing does not permanently drop the narrower bans it covers', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expires = new Date(start + 10000).toISOString();
    reconciler.accept(snapshot(1, [{ target: '198.51.100.7', expiresAt: expires }]));
    await reconciler.reconcile();
    const originalAdd = backend.add.bind(backend);
    backend.add = async (target, ttl) => {
        if (target === '198.51.100.0/24') throw new Error('rejected');
        return originalAdd(target, ttl);
    };
    reconciler.accept(
        snapshot(2, [
            { target: '198.51.100.7', expiresAt: expires },
            { target: '198.51.100.0/24', expiresAt: expires }
        ])
    );
    await assert.rejects(reconciler.reconcile(), /rejected/);
    await assert.rejects(reconciler.reconcile(), /rejected/);
    await assert.rejects(reconciler.reconcile(), /rejected/);
    // Initial install plus one same-pass restore per failed covering add: protection is never left dropped.
    assert.equal(backend.calls.filter(call => call === 'add 198.51.100.7 10').length, 4);
    assert.equal(reconciler.state.active, 1);
});

test('a failed TTL refresh re-add restores the old element instead of dropping the ban', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    reconciler.accept(snapshot());
    await reconciler.reconcile();
    const originalAdd = backend.add.bind(backend);
    backend.add = async (target, ttl) => {
        if (ttl === 20) throw new Error('refresh rejected');
        return originalAdd(target, ttl);
    };
    reconciler.accept(snapshot(2, [{ target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() }]));
    await assert.rejects(reconciler.reconcile(), /refresh rejected/);
    assert.deepEqual(backend.calls.slice(-2), ['remove 192.0.2.1', 'add 192.0.2.1 10'], 'old expiry re-added');
    assert.equal(reconciler.state.active, 1);
});

/** Models nftables interval sets: inserting an element that overlaps an installed one is rejected. */
class OverlapBackend extends Backend {
    installed = new Map<string, { first: number; last: number }>();
    failAdds = new Map<string, number>();
    private span(target: string) {
        const [ip, bits = '32'] = target.split('/');
        const base = ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
        const size = 2 ** (32 - Number(bits));
        const first = Math.floor(base / size) * size;
        return { first, last: first + size - 1 };
    }
    async add(target: string, ttl: number) {
        const left = this.failAdds.get(target) ?? 0;
        if (left > 0) {
            this.failAdds.set(target, left - 1);
            throw new Error('transient add failure');
        }
        const range = this.span(target);
        for (const other of this.installed.values()) if (range.first <= other.last && other.first <= range.last) throw new Error('interval overlaps');
        this.installed.set(target, range);
        this.calls.push('add ' + target + ' ' + ttl);
    }
    async remove(target: string) {
        this.installed.delete(target);
        this.calls.push('remove ' + target);
    }
}

test('covering CIDR replaces an installed host despite transient add failures; host protection is kept meanwhile', async () => {
    const backend = new OverlapBackend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const host = { target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() };
    reconciler.accept(snapshot(1, [host]));
    await reconciler.reconcile();
    assert.deepEqual([...backend.installed.keys()], ['192.0.2.1']);
    backend.failAdds.set('192.0.2.0/24', 2);
    reconciler.accept(snapshot(2, [host, { target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }]));
    for (let pass = 0; pass < 2; pass++) {
        await assert.rejects(reconciler.reconcile(), /transient add failure/);
        assert.deepEqual([...backend.installed.keys()], ['192.0.2.1'], 'host stays protected after failed CIDR add');
    }
    await reconciler.reconcile();
    assert.deepEqual([...backend.installed.keys()], ['192.0.2.0/24']);
    assert.equal(reconciler.state.active, 1);
});

test('a persistently failing covering CIDR never costs the fallback host its protection', async () => {
    const backend = new OverlapBackend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const host = { target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() };
    reconciler.accept(snapshot(1, [host]));
    await reconciler.reconcile();
    backend.failAdds.set('192.0.2.0/24', 100);
    reconciler.accept(snapshot(2, [host, { target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }]));
    for (let pass = 0; pass < 4; pass++) {
        await assert.rejects(reconciler.reconcile());
        assert.deepEqual([...backend.installed.keys()], ['192.0.2.1']);
    }
});

test('a covering range whose covered removals outlast its TTL is not installed and the covered host is restored', async () => {
    let now = start;
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => now);
    reconciler.accept(snapshot(1, [{ target: '192.0.2.5', expiresAt: new Date(start + 60000).toISOString() }]));
    await reconciler.reconcile();
    backend.calls.length = 0;
    const originalRemove = backend.remove.bind(backend);
    backend.remove = async (target: string) => {
        await originalRemove(target);
        now += 6000; // the removal outlasts the range's remaining TTL
    };
    reconciler.accept(
        snapshot(2, [
            { target: '192.0.2.0/24', expiresAt: new Date(start + 5000).toISOString() },
            { target: '192.0.2.5', expiresAt: new Date(start + 60000).toISOString() }
        ])
    );
    await reconciler.reconcile();
    assert.deepEqual(backend.calls, ['remove 192.0.2.5', 'add 192.0.2.5 54']);
    assert.equal(
        backend.calls.some(call => call.startsWith('add 192.0.2.0/24')),
        false
    );
});

test('a skipped expired covering range does not leave a new narrower ban uninstalled', async () => {
    let now = start;
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => now);
    reconciler.accept(snapshot(1, [{ target: '192.0.2.5', expiresAt: new Date(start + 60000).toISOString() }]));
    await reconciler.reconcile();
    const originalRemove = backend.remove.bind(backend);
    backend.remove = async (target: string) => {
        await originalRemove(target);
        now += 6000; // the covering range expires while the covered entry is removed
    };
    reconciler.accept(
        snapshot(2, [
            { target: '192.0.2.0/24', expiresAt: new Date(start + 5000).toISOString() },
            { target: '192.0.2.5', expiresAt: new Date(start + 60000).toISOString() },
            { target: '192.0.2.7', expiresAt: new Date(start + 60000).toISOString() }
        ])
    );
    await reconciler.reconcile();
    assert.ok(
        backend.calls.some(call => call.startsWith('add 192.0.2.7 ')),
        'the narrower ban is installed by the follow-up pass'
    );
    assert.equal(reconciler.state.appliedRevision, 2);
});

test('a covered host the new snapshot no longer requests is not restored when the covering CIDR add fails', async () => {
    const backend = new OverlapBackend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const host = { target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() };
    const cidr = { target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() };
    reconciler.accept(snapshot(1, [host]));
    await reconciler.reconcile();
    backend.failAdds.set('192.0.2.0/24', 100);
    reconciler.accept(snapshot(2, [cidr]));
    for (let pass = 0; pass < 3; pass++) {
        await assert.rejects(reconciler.reconcile(), /transient add failure/);
        assert.deepEqual([...backend.installed.keys()], [], 'dropped host stays removed');
    }
    assert.equal(backend.calls.filter(call => call.startsWith('add 192.0.2.1 ')).length, 1);
});

test('a covered host the snapshot still requests is restored with the snapshot TTL when the covering CIDR add fails', async () => {
    const backend = new OverlapBackend();
    const reconciler = new FirewallReconciler(backend, () => start);
    reconciler.accept(snapshot(1, [{ target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() }]));
    await reconciler.reconcile();
    backend.failAdds.set('192.0.2.0/24', 100);
    reconciler.accept(
        snapshot(2, [
            { target: '192.0.2.1', expiresAt: new Date(start + 30000).toISOString() },
            { target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }
        ])
    );
    await assert.rejects(reconciler.reconcile());
    assert.deepEqual([...backend.installed.keys()], ['192.0.2.1']);
    assert.equal(backend.calls.at(-1), 'add 192.0.2.1 30');
});

test('a host unblocked by a newer snapshot during the covering-CIDR removal is not restored, and the newer revision applies in the same run', async () => {
    class Racing extends OverlapBackend {
        onRemove?: (target: string) => void;
        async remove(target: string) {
            await super.remove(target);
            this.onRemove?.(target);
        }
    }
    const backend = new Racing();
    const reconciler = new FirewallReconciler(backend, () => start);
    reconciler.accept(snapshot(1, [{ target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() }]));
    await reconciler.reconcile();
    backend.failAdds.set('192.0.2.0/24', 1);
    reconciler.accept(snapshot(2, [{ target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }]));
    backend.onRemove = target => {
        if (target !== '192.0.2.1') return;
        backend.onRemove = undefined;
        reconciler.accept(snapshot(3, []));
        reconciler.schedule();
    };
    // The pass is abandoned before the obsolete CIDR add; revision 3 is applied by the same run, without another trigger.
    await reconciler.reconcile();
    assert.deepEqual([...backend.installed.keys()], [], 'host stays unblocked');
    assert.equal(backend.calls.filter(call => call.startsWith('add 192.0.2.1 ')).length, 1, 'host was not re-added');
    assert.equal(reconciler.state.appliedRevision, 3);
    assert.equal(reconciler.state.active, 0);
    assert.equal(reconciler.state.errors, 0, 'the CIDR add was never attempted, so nothing failed');
    assert.equal(backend.calls.filter(call => call.startsWith('add 192.0.2.0/24')).length, 0);
});

test('a covered host unblocked by a newer snapshot while an earlier host is being restored is not restored', async () => {
    class Racing extends OverlapBackend {
        onAdd?: (target: string) => void;
        async add(target: string, ttl: number) {
            await super.add(target, ttl);
            this.onAdd?.(target);
        }
    }
    const backend = new Racing();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expiresAt = new Date(start + 20000).toISOString();
    reconciler.accept(
        snapshot(1, [
            { target: '192.0.2.1', expiresAt },
            { target: '192.0.2.2', expiresAt }
        ])
    );
    await reconciler.reconcile();
    backend.failAdds.set('192.0.2.0/24', 1);
    reconciler.accept(
        snapshot(2, [
            { target: '192.0.2.1', expiresAt },
            { target: '192.0.2.2', expiresAt },
            { target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }
        ])
    );
    backend.onAdd = target => {
        if (target !== '192.0.2.1') return;
        backend.onAdd = undefined;
        reconciler.accept(snapshot(3, [{ target: '192.0.2.1', expiresAt }]));
        reconciler.schedule();
    };
    await reconciler.reconcile();
    assert.deepEqual([...backend.installed.keys()], ['192.0.2.1']);
    assert.equal(backend.calls.filter(call => call.startsWith('add 192.0.2.2 ')).length, 1, 'second host was not re-added');
});

for (const hostStillRequested of [false, true]) {
    test(`a covering CIDR dropped by a newer revision during the host removal is never added (host ${hostStillRequested ? 'still' : 'no longer'} requested)`, async () => {
        class Racing extends OverlapBackend {
            onRemove?: (target: string) => void;
            async remove(target: string) {
                await super.remove(target);
                this.onRemove?.(target);
            }
        }
        const backend = new Racing();
        const reconciler = new FirewallReconciler(backend, () => start);
        const hostBlock = { target: '192.0.2.1', expiresAt: new Date(start + 20000).toISOString() };
        reconciler.accept(snapshot(1, [hostBlock]));
        await reconciler.reconcile();
        reconciler.accept(snapshot(2, [{ target: '192.0.2.0/24', expiresAt: new Date(start + 10000).toISOString() }]));
        backend.onRemove = target => {
            if (target !== '192.0.2.1') return;
            backend.onRemove = undefined;
            reconciler.accept(snapshot(3, hostStillRequested ? [hostBlock] : []));
        };
        await reconciler.reconcile();
        assert.equal(backend.calls.filter(call => call.startsWith('add 192.0.2.0/24')).length, 0, 'obsolete CIDR never installed');
        assert.deepEqual([...backend.installed.keys()], hostStillRequested ? ['192.0.2.1'] : []);
        assert.equal(reconciler.state.appliedRevision, 3);
        assert.equal(reconciler.state.active, hostStillRequested ? 1 : 0);
    });
}

test('identical re-publications mid-pass do not roll back a covering CIDR pass', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expiresAt = new Date(start + 600_000).toISOString();
    const hosts = ['192.0.2.1', '192.0.2.2', '192.0.2.3'].map(target => ({ target, expiresAt }));
    reconciler.accept(snapshot(1, hosts));
    await reconciler.reconcile();
    const blocks2 = [...hosts, { target: '192.0.2.0/24', expiresAt }];
    reconciler.accept(snapshot(2, blocks2));
    let heartbeats = 0;
    const remove = backend.remove.bind(backend);
    backend.remove = async (target: string) => {
        await remove(target);
        if (heartbeats < 20) {
            heartbeats++;
            reconciler.accept(snapshot(2, blocks2));
        }
    };
    backend.calls.length = 0;
    await reconciler.reconcile();
    assert.equal(heartbeats, 3);
    assert.deepEqual(backend.calls, ['remove 192.0.2.1', 'remove 192.0.2.2', 'remove 192.0.2.3', 'add 192.0.2.0/24 600']);
    assert.equal(reconciler.state.appliedRevision, 2);
});

test('20 identical re-publications cost about 4 kernel ops', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expiresAt = new Date(start + 600_000).toISOString();
    const hosts = ['192.0.2.1', '192.0.2.2', '192.0.2.3'].map(target => ({ target, expiresAt }));
    reconciler.accept(snapshot(1, hosts));
    await reconciler.reconcile();
    reconciler.accept(snapshot(2, [...hosts, { target: '192.0.2.0/24', expiresAt }]));
    backend.calls.length = 0;
    let heartbeats = 0;
    const remove = backend.remove.bind(backend);
    backend.remove = async (target: string) => {
        await remove(target);
        // Heartbeats keep landing for the whole pass.
        for (let i = 0; i < 7 && heartbeats < 20; i++, heartbeats++)
            reconciler.accept(snapshot(2, [...hosts, { target: '192.0.2.0/24', expiresAt }]));
    };
    await reconciler.reconcile();
    assert.equal(heartbeats, 20);
    assert.equal(backend.calls.length, 4);
});

test('a newer revision that still requests the covering CIDR does not abort its install', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expiresAt = new Date(start + 600_000).toISOString();
    const hosts = ['192.0.2.1', '192.0.2.2'].map(target => ({ target, expiresAt }));
    reconciler.accept(snapshot(1, hosts));
    await reconciler.reconcile();
    const cidr = { target: '192.0.2.0/24', expiresAt };
    reconciler.accept(snapshot(2, [...hosts, cidr]));
    let bans = 0;
    const remove = backend.remove.bind(backend);
    backend.remove = async (target: string) => {
        await remove(target);
        // A fresh ban arrives (new revision, longer TTL for the CIDR) during every clear.
        bans++;
        reconciler.accept(
            snapshot(2 + bans, [
                ...hosts,
                { target: '192.0.2.0/24', expiresAt: new Date(start + 600_000 + bans * 1000).toISOString() },
                { target: `198.51.100.${bans}`, expiresAt }
            ])
        );
    };
    backend.calls.length = 0;
    await reconciler.reconcile();
    // Installed at the latest TTL despite the stream; never rolled back by restoring the hosts.
    assert.ok(backend.calls.includes('add 192.0.2.0/24 ' + (600 + bans)), backend.calls.join('|'));
    assert.equal(backend.calls.filter(c => c.startsWith('add 192.0.2.1 ')).length, 0);
});

test('a newer revision that drops the covering CIDR abandons its install and restores hosts', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expiresAt = new Date(start + 600_000).toISOString();
    const hosts = ['192.0.2.1', '192.0.2.2'].map(target => ({ target, expiresAt }));
    reconciler.accept(snapshot(1, hosts));
    await reconciler.reconcile();
    reconciler.accept(snapshot(2, [...hosts, { target: '192.0.2.0/24', expiresAt }]));
    const remove = backend.remove.bind(backend);
    let dropped = false;
    backend.remove = async (target: string) => {
        await remove(target);
        if (!dropped) {
            dropped = true;
            reconciler.accept(snapshot(3, hosts));
        }
    };
    backend.calls.length = 0;
    await reconciler.reconcile();
    assert.ok(!backend.calls.some(c => c.startsWith('add 192.0.2.0/24')));
    assert.ok(backend.calls.some(c => c.startsWith('add 192.0.2.1 ')));
});

test('the requested-block index is computed once per newer revision, not per removed host', async () => {
    const backend = new Backend();
    const reconciler = new FirewallReconciler(backend, () => start);
    const expiresAt = new Date(start + 600_000).toISOString();
    const hosts = Array.from({ length: 2000 }, (_, i) => ({ target: `10.1.${i >> 8}.${i & 255}`, expiresAt }));
    reconciler.accept(snapshot(1, hosts));
    await reconciler.reconcile();
    const cidr = { target: '10.1.0.0/16', expiresAt };
    reconciler.accept(snapshot(2, [...hosts, cidr]));
    const computed: number[] = [];
    const internals = reconciler as unknown as { computeRequested(s: FirewallSnapshot): Map<string, number> };
    const compute = internals.computeRequested.bind(reconciler);
    internals.computeRequested = s => {
        computed.push(s.revision);
        return compute(s);
    };
    const remove = backend.remove.bind(backend);
    let arrived = false;
    backend.remove = async (target: string) => {
        await remove(target);
        if (arrived) return;
        arrived = true;
        reconciler.accept(snapshot(3, [...hosts, cidr, { target: '198.51.100.1', expiresAt }]));
    };
    backend.calls.length = 0;
    await reconciler.reconcile();
    assert.ok(backend.calls.includes('add 10.1.0.0/16 600'), 'covering CIDR installed');
    assert.equal(computed.filter(revision => revision === 3).length, 1, `index recomputed: ${computed.join(',')}`);
});
