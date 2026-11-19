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

test('a command result with an ended snapshot ends the context now; the terminal event supplies the reason once', async () => {
    const h = harness();
    try {
        const state = h.signaling.remember(h.peer, h.client, h.snapshot('D'));
        const emitted: string[] = [];
        state.dialog = { emit: (name: string, reason: string) => emitted.push(`${name}:${reason}`) };
        state.peer = h.peer;
        h.client.request = async () => ({
            payload: { $case: 'result', result: { certainty: 2, snapshot: { ...h.snapshot('D', true), revision: 2n, commandSequence: 2n } } }
        });
        await h.signaling.command(state, { $case: 'cancel', cancel: {} }).catch(() => undefined);
        assert.equal(state.ended, true, 'ended synchronously');
        assert.deepEqual(emitted, [], 'announcement waits for the terminal event');
        await h.receive(h.event('D', 'evD'));
        assert.deepEqual(emitted, ['ended:bye'], 'a peer BYE racing the command is a bye');
        await h.receive(h.event('D', 'evD2'));
        assert.deepEqual(emitted, ['ended:bye'], 'terminal handling is idempotent');
        assert.equal(state.endTimer, undefined);
        assert.equal(h.live(), 0);
    } finally {
        h.signaling.stopped = true;
    }
});

test('a command-result end with no terminal event is announced as terminated by the fallback timer', async () => {
    const h = harness();
    try {
        h.signaling.endEventGraceMs = 10;
        const state = h.signaling.remember(h.peer, h.client, h.snapshot('F'));
        const emitted: string[] = [];
        state.dialog = { emit: (name: string, reason: string) => emitted.push(`${name}:${reason}`) };
        h.client.request = async () => ({
            payload: { $case: 'result', result: { certainty: 2, snapshot: { ...h.snapshot('F', true), revision: 2n, commandSequence: 2n } } }
        });
        await h.signaling.command(state, { $case: 'cancel', cancel: {} }).catch(() => undefined);
        assert.deepEqual(emitted, []);
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.deepEqual(emitted, ['ended:terminated']);
        // A terminal event arriving after the fallback does not announce it again.
        await h.receive(h.event('F', 'evF'));
        assert.deepEqual(emitted, ['ended:terminated']);
    } finally {
        h.signaling.stopped = true;
    }
});

function openHarness(resultSnapshot: (h: ReturnType<typeof harness>) => any, certainty = 2) {
    const h = harness();
    h.signaling.peers = new Map([['sb', { ...h.peer, endpoint: { id: 'sb', acceptNew: true } }]]);
    h.peer.endpoint = h.signaling.peers.get('sb').endpoint;
    h.signaling.peers.get('sb').client = h.client;
    Object.defineProperty(h.signaling, 'isConnected', { get: () => true });
    h.signaling.config = { SIP_ALLOWED_DOMAINS: ['gw.example'] };
    h.client.negotiated.sipbridge = { id: 'sipbridge' };
    const commands: string[] = [];
    h.client.request = async (frame: any) => {
        const action = frame.command.action.$case;
        commands.push(action);
        if (action === 'openUac') {
            h.signaling.peers.get('sb').client = h.client;
            return { payload: { $case: 'result', result: { certainty, snapshot: resultSnapshot(h) } } };
        }
        return { payload: { $case: 'result', result: { certainty: 2, snapshot: h.snapshot('O') } } };
    };
    return { h, commands };
}

test('a CANCEL queued during OpenUac is skipped when the open result is already answered; the dialog is delivered', async () => {
    const { h, commands } = openHarness(h => ({ ...h.snapshot('O'), answered: true }));
    try {
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await attempt.cancel();
        const dialog = await attempt.completed;
        assert.ok(dialog, 'answered dialog resolves for the caller ACK-aware cleanup');
        assert.deepEqual(commands, ['openUac'], 'no CANCEL is sent once the answer is observed');
    } finally {
        h.signaling.stopped = true;
    }
});

test('a CANCEL queued during OpenUac is skipped when the open result is ended', async () => {
    const { h, commands } = openHarness(h => ({ ...h.snapshot('O'), ended: true }));
    try {
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await attempt.cancel();
        await assert.rejects(attempt.completed, /ended/);
        assert.deepEqual(commands, ['openUac']);
    } finally {
        h.signaling.stopped = true;
    }
});

test('a CANCEL queued during OpenUac is still sent when the setup is pending', async () => {
    const { h, commands } = openHarness(h => h.snapshot('O'));
    try {
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await attempt.cancel();
        const state = [...h.contexts.values()].find((context: any) => context.snapshot.context.id === 'O');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(commands.slice(0, 2), ['openUac', 'cancel']);
        state.deferred.reject(new Error('test cleanup'));
        await attempt.completed.catch(() => undefined);
    } finally {
        h.signaling.stopped = true;
    }
});

test('an UNKNOWN OpenUac result that carries a snapshot fences the context', async () => {
    const { h, commands } = openHarness(h => h.snapshot('O'), 0);
    try {
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await assert.rejects(attempt.completed, (error: any) => error instanceof NativeOperationError && error.uncertain);
        const state = [...h.contexts.values()].find((context: any) => context.snapshot.context.id === 'O');
        assert.equal(state.uncertain, true);
        await assert.rejects(attempt.cancel(), (error: any) => error instanceof NativeOperationError && error.uncertain);
        assert.deepEqual(commands, ['openUac'], 'a fenced context is never commanded');
    } finally {
        h.signaling.stopped = true;
    }
});
