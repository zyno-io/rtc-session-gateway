import assert from 'node:assert/strict';
import test from 'node:test';
import { messageCarriesSdp, NativeDialog, NativeOperationError, SipbridgeSignaling } from '../src/sipbridge-signaling';
import { ContextSnapshot, DialogEvent_Kind, SipMessage } from '../src/sipbridge/generated/sipbridge-control';

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

const answeredEvent = (h: ReturnType<typeof harness>, id: string, correlationId: string, contentType: string, answered = true) => ({
    correlationId,
    payload: {
        $case: 'dialogEvent',
        dialogEvent: {
            kind: DialogEvent_Kind.ANSWERED,
            snapshot: { ...h.snapshot(id), answered },
            message: SipMessage.fromJSON({
                status: 200,
                body: Buffer.from('v=0\r\n').toString('base64'),
                headers: [{ name: 'Content-Type', value: contentType }]
            }),
            operationId: '',
            error: '',
            inviteCseq: 0
        }
    }
});

test('a CANCEL queued during OpenUac is skipped when the open result is already answered; the dialog waits for the answered event', async () => {
    const { h, commands } = openHarness(h => ({ ...h.snapshot('O'), answered: true }));
    try {
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await attempt.cancel();
        let settled = false;
        void attempt.completed.then(
            () => (settled = true),
            () => (settled = true)
        );
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(settled, false, 'an answer first seen from a snapshot is not classified yet: the attempt stays pending');
        await h.signaling.receive(h.signaling.peers.get('sb'), h.client, answeredEvent(h, 'O', 'ans-sdp', 'application/sdp'));
        const dialog = await attempt.completed;
        assert.ok(dialog, 'answered dialog resolves for the caller ACK-aware cleanup');
        assert.equal(dialog.answerIsSdp, true);
        assert.deepEqual(commands, ['openUac'], 'no CANCEL is sent once the answer is observed');
    } finally {
        h.signaling.stopped = true;
    }
});

test('Codex 2: a snapshot-first answer carrying a mislabeled body resolves as not-SDP once the answered event arrives', async () => {
    const { h } = openHarness(h => ({ ...h.snapshot('O'), answered: true }));
    try {
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await new Promise(resolve => setTimeout(resolve, 10));
        const state = [...h.contexts.values()].find((context: any) => context.snapshot.context.id === 'O');
        assert.equal(new NativeDialog(state, h.signaling).answerIsSdp, false, 'an unknown classification never reads as SDP');
        await h.signaling.receive(h.signaling.peers.get('sb'), h.client, answeredEvent(h, 'O', 'ans-text', 'text/plain'));
        const dialog = await attempt.completed;
        assert.equal(dialog.answerIsSdp, false);
    } finally {
        h.signaling.stopped = true;
    }
});

test('an offerless re-INVITE uses the SDP-carrying final response as the offer', async () => {
    const snapshot = { remoteSdp: Buffer.from('stale-previous-sdp') };
    const dialogWith = (response: unknown) => {
        const owner = {
            command: async (_state: unknown, _action: unknown, onResult?: (result: unknown) => void) => {
                onResult?.({ response });
                return snapshot;
            }
        };
        return new NativeDialog({} as any, owner as any);
    };
    const body = Buffer.from('v=0\r\n');
    const message = (contentType?: string) => ({ body, headers: contentType ? [{ name: 'Content-Type', value: contentType }] : [] });
    assert.deepEqual(await dialogWith(message('application/sdp')).reinviteOffer(), { sdp: body.toString('utf8'), offered: true });
    assert.deepEqual(await dialogWith(message('text/plain')).reinviteOffer(), { sdp: '', offered: false });
    assert.deepEqual(await dialogWith(message()).reinviteOffer(), { sdp: '', offered: false });
    assert.deepEqual(await dialogWith(undefined).reinviteOffer(), { sdp: '', offered: false });
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

test('a CANCEL queued behind a refused one is skipped once the answer is observed, and concurrent requests share one sequence', async () => {
    const signaling = new SipbridgeSignaling({} as any) as any;
    signaling.stopped = false;
    signaling.cancelRetryDelaysMs = [1, 1, 1];
    const writes: string[] = [];
    let state: any;
    const client = {
        async request() {
            writes.push('cancel');
            // The first CANCEL is definitely refused; the destination's 200 is observed before any later command runs.
            state.snapshot.answered = true;
            return { payload: { $case: 'result', result: { certainty: 1, error: 'capacity', snapshot: undefined } } };
        }
    };
    state = { peer: { client }, snapshot: {}, sequence: 0n, tail: Promise.resolve(), uncertain: false, ended: false };
    const first = signaling.sendCancel(state);
    const second = signaling.sendCancel(state);
    assert.equal(first, second, 'one in-flight cancel per attempt');
    await assert.rejects(first);
    assert.equal(writes.length, 1);

    // A later request after the answer sends nothing.
    await signaling.sendCancel(state);
    // A command already queued when the answer arrived is skipped at dispatch time.
    await signaling.command(state, { $case: 'cancel', cancel: {} });
    assert.equal(writes.length, 1);
    assert.equal(state.cancelInFlight, undefined);
});

test('an answering response carries SDP only with exactly one application/sdp Content-Type (parameters and case allowed)', () => {
    const body = Buffer.from('v=0\r\n');
    const type = (value: string) => ({ name: 'Content-Type', value });
    assert.equal(messageCarriesSdp({ body, headers: [type('application/sdp')] }), true);
    assert.equal(messageCarriesSdp({ body, headers: [type(' Application/SDP ; charset=utf-8')] }), true);
    assert.equal(messageCarriesSdp({ body, headers: [type('text/plain')] }), false);
    assert.equal(messageCarriesSdp({ body, headers: [] }), false);
    assert.equal(messageCarriesSdp({ body, headers: [type('application/sdp'), type('application/sdp')] }), false);
    assert.equal(messageCarriesSdp({ body: Buffer.alloc(0), headers: [type('application/sdp')] }), false);
});

test('Codex 3 (r23): SDP media type normalization mirrors Go (TrimSpace/EqualFold), not JS trim()', () => {
    const body = Buffer.from('v=0\r\n');
    const type = (value: string) => ({ name: 'Content-Type', value });
    for (const space of ['\u0085', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '\v', '\f', '\t'])
        assert.equal(messageCarriesSdp({ body, headers: [type(space + 'application/sdp' + space + ';x=1')] }), true, JSON.stringify(space));
    assert.equal(messageCarriesSdp({ body, headers: [type('application/sdp\u0085;x=1')] }), true);
    // Go does not trim U+FEFF or U+200B; JS trim() trims U+FEFF.
    assert.equal(messageCarriesSdp({ body, headers: [type('﻿application/sdp')] }), false);
    assert.equal(messageCarriesSdp({ body, headers: [type('application/sdp​')] }), false);
    // EqualFold uses Unicode simple folding: U+017F (long s) folds to s.
    assert.equal(messageCarriesSdp({ body, headers: [type('application/ſdp')] }), true);
});

test('Codex 4 (r23): concurrent outbound opens reserve capacity; the second is refused locally at 1023 live', async () => {
    const { h, commands } = openHarness(h => h.snapshot('O1'));
    try {
        for (let i = 0; i < 1023; i++) h.contexts.set('fill-' + i, { ended: false, snapshot: {} });
        const gate = Promise.withResolvers<void>();
        const original = h.client.request;
        h.client.request = async (frame: any) => {
            await gate.promise;
            return original(frame);
        };
        const first = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        const second = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await assert.rejects(second.completed, (err: any) => err instanceof NativeOperationError && /Native context capacity/.test(err.message));
        assert.deepEqual(commands, [], 'the refused open sent nothing');
        assert.equal(h.signaling.liveContexts(), 1024, 'the reservation counts toward admission');
        gate.resolve();
        void first.completed.catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(h.signaling.reservedContexts.size, 0, 'converted to the tracked context');
        assert.equal(h.signaling.liveContexts(), 1024, 'tracked once, never double counted');
        // A failed open releases its reservation exactly once.
        for (const key of [...h.contexts.keys()]) if (key.startsWith('fill-') && Number(key.slice(5)) > 500) h.contexts.delete(key);
        h.client.request = async () => {
            throw new Error('boom');
        };
        const failed = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        await assert.rejects(failed.completed);
        assert.equal(h.signaling.reservedContexts.size, 0);
    } finally {
        h.signaling.stopped = true;
    }
});

test("an open's own early dialog event is accepted at capacity and converts its reservation (no double counting)", async () => {
    let bootstrapId = '';
    const { h } = openHarness(h => h.snapshot(bootstrapId));
    try {
        for (let i = 0; i < 1023; i++) h.contexts.set('fill-' + i, { ended: false, snapshot: {} });
        const gate = Promise.withResolvers<void>();
        const original = h.client.request;
        h.client.request = async (frame: any) => {
            bootstrapId = frame.command.context.id;
            await gate.promise;
            return original(frame);
        };
        const attempt = h.signaling.openDialog({ requestUri: 'sip:x@y.example', sdp: '' });
        void attempt.completed.catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(h.signaling.liveContexts(), 1024, 'the reservation counts toward admission');
        // The event names the context by the bootstrap id, before the OpenUac result arrives.
        await h.signaling.receive(h.signaling.peers.get('sb'), h.client, answeredEvent(h, bootstrapId, 'early-ans', 'application/sdp'));
        assert.deepEqual(h.replies, ['early-ans'], 'the early event was replied, not refused');
        assert.equal(h.signaling.reservedContexts.size, 0, 'reservation consumed');
        assert.equal(h.signaling.liveContexts(), 1024, 'tracked once, never double counted');
        gate.resolve();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(h.signaling.liveContexts(), 1024);
        assert.equal(h.signaling.reservedContexts.size, 0);
    } finally {
        h.signaling.stopped = true;
    }
});
