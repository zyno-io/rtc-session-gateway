import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeOperationError, SipbridgeSignaling } from '../src/sipbridge-signaling';
import { ContextSnapshot, DialogEvent_Kind } from '../src/sipbridge/generated/sipbridge-control';

const authority = { service: 's', generation: 'g', primaryId: 'p', schemaVersion: 1 };

function harness() {
    const signaling = new SipbridgeSignaling({} as any) as any;
    const replies: string[] = [];
    const client: any = {
        negotiated: { stateAuthority: authority, applicationLease: { term: 't1' } },
        reply: async (correlationId: string) => {
            replies.push(correlationId);
        }
    };
    const peer: any = { endpoint: { id: 'sb' }, client, connecting: false, retryAt: 0, delay: 250 };
    signaling.stopped = false;
    const snapshot = (id: string, ended = false) =>
        ContextSnapshot.fromJSON({
            context: { id, state: { authority, groupId: 'g-' + id, incarnation: 'i-' + id } },
            application: signaling.process,
            applicationLeaseTerm: 't1',
            revision: '1',
            commandSequence: '1',
            ended
        });
    const event = (id: string, correlationId: string, kind = DialogEvent_Kind.ENDED) => ({
        correlationId,
        payload: { $case: 'dialogEvent', dialogEvent: { kind, snapshot: snapshot(id), operationId: '', error: '', inviteCseq: 0 } }
    });
    const contexts: Map<string, any> = signaling.contexts;
    const live = () => [...contexts.values()].filter(context => !context.ended).length;
    const has = (id: string) => [...contexts.values()].some(context => context.snapshot.context.id === id);
    return {
        signaling,
        peer,
        client,
        snapshot,
        event,
        contexts,
        live,
        has,
        replies,
        receive: (frame: unknown) => signaling.receive(peer, client, frame)
    };
}

test('a redelivered terminal event after its tombstone was evicted never recreates a live context', async () => {
    const h = harness();
    try {
        await h.receive(h.event('A', 'evA'));
        assert.equal(h.has('A'), true);
        assert.equal(h.live(), 0, 'a terminal event for an unknown context is recorded ended');
        // The tombstone is lost (simulated eviction); the dedupe receipt remains.
        for (const [key, context] of [...h.contexts]) if (context.snapshot.context.id === 'A') h.contexts.delete(key);
        const before = h.contexts.size;
        await h.receive(h.event('A', 'evA'));
        assert.equal(h.has('A'), false, 'duplicate is acknowledged without bookkeeping');
        assert.equal(h.contexts.size, before);
        assert.equal(h.live(), 0);
        assert.deepEqual(h.replies, ['evA', 'evA']);
    } finally {
        h.signaling.stopped = true;
    }
});

test('a terminal event whose receipt was also forgotten still creates only an ended context', async () => {
    const h = harness();
    try {
        await h.receive(h.event('B', 'evB', DialogEvent_Kind.FAILED));
        h.contexts.clear();
        h.signaling.events.clear();
        await h.receive(h.event('B', 'evB', DialogEvent_Kind.FAILED));
        assert.equal(h.live(), 0);
        assert.equal(h.has('B'), true);
    } finally {
        h.signaling.stopped = true;
    }
});

test('a late command result for an unknown context with an ended snapshot is remembered as ended', () => {
    const h = harness();
    try {
        const state = h.signaling.remember(h.peer, h.client, h.snapshot('C', true));
        assert.equal(state.ended, true);
        assert.equal(h.live(), 0);
    } finally {
        h.signaling.stopped = true;
    }
});

test('tombstones retired under 120s ago are never evicted, even over the cap; older ones are trimmed oldest-first', async () => {
    const h = harness();
    try {
        for (let i = 0; i < 4100; i++) await h.receive(h.event('X' + i, 'ev' + i));
        assert.equal(h.contexts.size, 4100, 'all recent tombstones are retained over the cap');
        const old = Date.now() - 200_000;
        let aged = 0;
        for (const context of h.contexts.values()) if (aged++ < 10) context.retiredAt = old;
        h.signaling.trimTombstones();
        assert.equal(h.contexts.size, 4096, 'only the aged excess is evicted');
        for (const context of h.contexts.values()) if (aged-- > 0) context.retiredAt = old;
        h.signaling.trimTombstones();
        assert.equal(h.contexts.size, 4096, 'the cap never evicts below itself');
    } finally {
        h.signaling.stopped = true;
    }
});

test('a definitely refused CANCEL is retried without fencing; an uncertain one is not retried', async () => {
    const signaling = new SipbridgeSignaling({} as any) as any;
    signaling.stopped = false;
    signaling.cancelRetryDelaysMs = [1, 1, 1];
    const state: any = { snapshot: {}, ended: false, uncertain: false };
    let calls = 0;
    signaling.command = async () => {
        if (++calls < 3) throw new NativeOperationError('capacity', false);
    };
    await signaling.sendCancel(state);
    assert.equal(calls, 3);
    assert.equal(state.uncertain, false);

    calls = 0;
    signaling.command = async () => {
        calls++;
        throw new NativeOperationError('capacity', false);
    };
    await assert.rejects(signaling.sendCancel(state), (error: NativeOperationError) => !error.uncertain);
    assert.equal(calls, 4, 'bounded by the schedule');
    assert.equal(state.uncertain, false);

    calls = 0;
    signaling.command = async () => {
        calls++;
        throw new NativeOperationError('unknown', true);
    };
    await assert.rejects(signaling.sendCancel(state), (error: NativeOperationError) => error.uncertain);
    assert.equal(calls, 1);

    // Setup answered meanwhile: stop retrying.
    calls = 0;
    signaling.command = async () => {
        calls++;
        state.snapshot.answered = true;
        throw new NativeOperationError('capacity', false);
    };
    await assert.rejects(signaling.sendCancel(state));
    assert.equal(calls, 1);
});
