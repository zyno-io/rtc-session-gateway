import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CallRegistry } from '../src/call-registry';
import { GatewayLifecycle } from '../src/gateway-lifecycle';
import { controlErrorForCommand } from '../src/session-commands';
import { SipGateway, SipOperationConflictError } from '../src/sip-gateway';
import { isSipTransferStatus } from '../src/sip-handoff-contract';
import {
    assertDirectMediaAnswer,
    assertRollbackAnswer,
    parseReferTarget,
    parseReplaces,
    rejectSdpOffer,
    relaySdp,
    sharesMediaEndpoint
} from '../src/sip-sdp';
import { loadFirewallConfig, SipFirewall } from '../src/sip-firewall';
import { NativeOperationError, type SipbridgeSignaling } from '../src/sipbridge-signaling';

const sdp = (ip: string, port = 40000, version = '1') =>
    [
        'v=0',
        `o=- 100 ${version} IN IP4 ${ip}`,
        's=test',
        `c=IN IP4 ${ip}`,
        't=0 0',
        `m=audio ${port} RTP/AVP 0 101`,
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:101 telephone-event/8000',
        'a=sendrecv',
        ''
    ].join('\r\n');
const turn = () => new Promise(resolve => setImmediate(resolve));

/** Stands in for NativeDialog: records every command and exposes the ACK-wait contract the gateway relies on. */
class Dialog extends EventEmitter {
    localSdp = sdp('10.0.0.3');
    remoteSdp = sdp('10.0.0.1');
    isEnded = false;
    isFenced = false;
    peerSource: { ip: string; port: number; transport: string } | undefined;
    byes = 0;
    reinvites: string[] = [];
    acks: string[] = [];
    requests: { method: string; body?: string; headers?: Record<string, string> }[] = [];
    log?: string[];
    name = 'dialog';
    reinviteFailure?: Error;
    /** Fences the leg when the re-INVITE fails, as an UNKNOWN native outcome does. */
    fenceOnReinviteFailure = false;
    reinviteHook?: (offer: string) => Promise<string>;
    offerlessGate?: Promise<void>;
    ackFailure?: Error;
    /** Fails only the first N ACKs (default: every ACK while ackFailure is set). */
    ackFailureLimit = Infinity;
    byeFailure?: Error;
    byeFailureLimit = Infinity;
    fenceOnAckFailure = false;
    /** Models an UNKNOWN native outcome: the context is fenced and, like NativeDialog, announces it once. */
    fence() {
        if (this.isFenced) return;
        this.isFenced = true;
        this.emit('fenced');
    }
    private buffered = new Map<number, string>();
    private waiters = new Map<number, { resolve: (body: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    constructor(
        public sipCallId = 'caller',
        public localTag = 'gateway-tag',
        public remoteTag = 'caller-tag'
    ) {
        super();
    }
    activate() {}
    async reinvite(offer: string) {
        this.reinvites.push(offer);
        if (offer) this.localSdp = offer;
        if (this.reinviteFailure) {
            if (this.fenceOnReinviteFailure) this.fence();
            throw this.reinviteFailure;
        }
        // An offerless re-INVITE returns the peer's 2xx offer.
        if (!offer) {
            await this.offerlessGate;
            return this.remoteSdp;
        }
        return this.reinviteHook ? this.reinviteHook(offer) : this.remoteSdp;
    }
    async ackAnswer(answer: string) {
        this.log?.push(`${this.name}:ack`);
        if (this.ackFailure && this.ackFailureLimit-- > 0) {
            if (this.fenceOnAckFailure) this.fence();
            throw this.ackFailure;
        }
        this.acks.push(answer);
        this.localSdp = answer;
    }
    async request(method: string, options: { body?: string; headers?: Record<string, string> } = {}) {
        this.requests.push({ method, ...options });
        const status = method === 'NOTIFY' ? /SIP\/2\.0 (\d+)/.exec(options.body ?? '')?.[1] : undefined;
        this.log?.push(`${this.name}:${method.toLowerCase()}${status ? `-${status}` : ''}`);
    }
    async bye() {
        if (this.byeFailure && this.byeFailureLimit-- > 0) throw this.byeFailure;
        this.log?.push(`${this.name}:bye`);
        this.byes++;
    }
    deliverAck(cseq: number, body: string) {
        const waiter = this.waiters.get(cseq);
        if (!waiter) {
            this.buffered.set(cseq, body);
            return;
        }
        clearTimeout(waiter.timer);
        this.waiters.delete(cseq);
        waiter.resolve(body);
    }
    awaitPeerAck(cseq: number, timeoutMs = 10_000) {
        const buffered = this.buffered.get(cseq);
        if (buffered !== undefined) return Promise.resolve(buffered);
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(cseq);
                reject(new NativeOperationError('Timed out waiting for peer ACK'));
            }, timeoutMs);
            this.waiters.set(cseq, { resolve, reject, timer });
        });
    }
    cancelPeerAckWait(cseq: number) {
        const waiter = this.waiters.get(cseq);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.waiters.delete(cseq);
        waiter.reject(new Error('cancelled'));
    }
}

class Response {
    finalResponseSent = false;
    status?: number;
    options?: { body?: string; headers?: Record<string, string> };
    statuses: number[] = [];
    answered?: string;
    log?: string[];
    answerGate?: Promise<void>;
    constructor(
        private dialog?: Dialog,
        private answerFailure?: Error
    ) {}
    async respond(status: number, options?: { body?: string; headers?: Record<string, string> }) {
        this.status = status;
        this.statuses.push(status);
        this.options = options;
        if (status >= 200) {
            this.finalResponseSent = true;
            this.log?.push(`response:${status}`);
        }
    }
    async answer(offer: string) {
        await this.answerGate;
        if (this.answerFailure) throw this.answerFailure;
        this.answered = offer;
        this.finalResponseSent = true;
        return this.dialog as never;
    }
}

function invite(headers: Record<string, string> = {}, callId = 'caller', address = '10.0.0.1', method = 'INVITE', cseq = 1) {
    const all: Record<string, string> = { 'call-id': callId, from: '<sip:18055550123@carrier.example>', ...headers };
    return {
        method,
        uri: 'sip:inbound@gateway.example',
        body: method === 'INVITE' && !('nobody' in headers) ? sdp(address) : '',
        callId,
        cseq,
        source: { ip: address, port: 5060, transport: 'udp' },
        headers: all,
        get: (name: string) => all[name.toLowerCase()]
    };
}

function request(method: string, body = '', cseq = 42, headers: Record<string, string> = {}) {
    const all: Record<string, string> = { cseq: `${cseq} ${method}`, ...headers };
    return {
        method,
        uri: 'sip:inbound@gateway.example',
        callId: 'x',
        body,
        cseq,
        headers: all,
        get: (name: string) => all[name.toLowerCase()]
    } as never;
}

async function fixture(
    options: {
        timeout?: number;
        lifecycle?: GatewayLifecycle;
        firewall?: SipFirewall;
        centerAddress?: string;
        ackGiveUpMs?: number;
        retryDelays?: number[];
    } = {}
) {
    const registry = new CallRegistry();
    const log: string[] = [];
    const caller = new Dialog('caller', 'gateway-tag', 'caller-tag');
    caller.name = 'caller';
    caller.log = log;
    const center = new Dialog('center', 'center-gateway-tag', 'center-tag');
    center.name = 'center';
    center.log = log;
    center.remoteSdp = sdp('10.0.0.2', 45000);
    const events: unknown[] = [];
    const requests: { method: string; params: any }[] = [];
    const opened: unknown[] = [];
    const provisionalSeen: number[] = [];
    let cancelled = 0;
    let prepareFailure: Error | undefined;
    let prepareHook: (() => Promise<void>) | undefined;
    let dialHook: (() => Promise<void>) | undefined;
    let replacementFailure: Error | undefined;
    let destroyHook: (() => Promise<void>) | undefined;
    let cancelFailure: Error | undefined;
    const sources: unknown[] = [];
    const finalized = {
        recordingId: 'recording',
        backendId: 'media-a',
        filePath: '/recordings/caller.pcap',
        recordingPath: 'caller.pcap',
        downloadPath: '/recordings/media-a/caller.pcap',
        durationMs: 2000,
        packets: 100
    };
    const hub = {
        findRoute: () => ({ connectionId: 'app', route: { url: 'control://app' } }),
        isConnected: () => true,
        async request(_id: string, method: string, params: unknown) {
            requests.push({ method, params });
            return { action: 'answer', sdp: sdp('10.0.0.3') };
        },
        sendEvent(_id: string, event: unknown) {
            events.push(event);
            return true;
        },
        on() {}
    };
    const signaling = {
        applicationReady: () => true,
        isDraining: () => false,
        openDialog(params: unknown) {
            opened.push(params);
            const attempt = {
                onProvisional: undefined as undefined | ((status: number) => void),
                cancel: async () => {
                    cancelled++;
                    if (cancelFailure) throw cancelFailure;
                },
                completed: (async () => {
                    await Promise.resolve();
                    attempt.onProvisional?.(183);
                    provisionalSeen.push(183);
                    if (dialHook) await dialHook();
                    return center as never;
                })()
            };
            return attempt;
        },
        async stop() {}
    } as unknown as SipbridgeSignaling;
    const media = {
        assertHandoffMedia(_id: string, owner: string) {
            assert.equal(owner, 'app');
            return 'endpoint-a';
        },
        async prepareHandoff(_id: string, _owner: string, _token: object, source: unknown) {
            sources.push(source);
            log.push('stop-recording');
            if (prepareHook) await prepareHook();
            if (prepareFailure) throw prepareFailure;
            return [finalized];
        },
        releaseHandoff() {},
        async destroySession() {
            if (destroyHook) await destroyHook();
            log.push('delete-media');
        }
    };
    const gateway = new SipGateway(
        { SIP_ALLOWED_DOMAINS: ['gateway.example'], ROUTES: [], EVENT_HTTP_TIMEOUT_MS: 1000 } as never,
        registry,
        {
            async postJson() {
                throw new Error('unexpected HTTP');
            }
        } as never,
        signaling,
        hub as never,
        options.lifecycle,
        {
            mediaController: media as never,
            handoffAckTimeoutMs: options.timeout ?? 1000,
            firewall: options.firewall,
            terminalRetryDelaysMs: options.retryDelays ?? [1, 2, 3],
            ackGiveUpMs: options.ackGiveUpMs ?? 40
        }
    );
    await gateway.handleInvite(invite() as never, new Response(caller) as never);
    await turn();
    const call = registry.get('caller')!;
    caller.reinviteHook = async () => {
        log.push('carrier-modify');
        return sdp('10.0.0.1');
    };
    const params = { sessionId: 'caller', mediaSessionId: 'call-media', transferId: 'transfer-1', requestUri: 'sip:center@center.example' };
    return {
        gateway,
        registry,
        caller,
        center,
        call,
        params,
        log,
        events,
        requests,
        finalized,
        hub,
        opened,
        provisionalSeen,
        sources,
        cancelled: () => cancelled,
        dials: () => opened.length,
        failRecording: () => {
            prepareFailure = new Error('recorder unavailable');
        },
        delayRecording: (hook: () => Promise<void>) => {
            prepareHook = hook;
        },
        delayDestroy: (hook: () => Promise<void>) => {
            destroyHook = hook;
        },
        failReplacement: () => {
            replacementFailure = new Error('Replacement dialog failed');
        },
        replacementResponse: (dialog?: Dialog) => new Response(dialog, replacementFailure),
        delayDial: (hook: () => Promise<void>) => {
            dialHook = hook;
        },
        failCancel: (error: Error) => {
            cancelFailure = error;
        }
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function handedOff(options?: Parameters<typeof fixture>[0]): Promise<Fixture> {
    const f = await fixture(options);
    await f.gateway.transfer(f.params, 'app');
    f.log.length = 0;
    return f;
}

test('handoff dials offerless, stops recording before carrier cutover and survives application disconnect', async () => {
    const f = await fixture();
    const result = await f.gateway.transfer(f.params, 'app');
    assert.equal((f.opened[0] as { sdp: string }).sdp, '', 'destination is dialed offerless');
    assert.deepEqual(f.log, ['stop-recording', 'carrier-modify', 'center:ack', 'delete-media']);
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.recordings, [f.finalized]);
    assert.equal(result.destinationSipCallId, 'center');
    assert.equal(f.call.ownership, 'handed-off');
    assert.match(f.caller.reinvites[0], /c=IN IP4 10\.0\.0\.2/);
    assert.match(f.center.acks[0], /c=IN IP4 10\.0\.0\.1/);
    await f.gateway.terminateCallsForControlConnection('app');
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0);
    assert.doesNotThrow(() => JSON.stringify(f.registry.list()));
    const snapshot = f.registry.list()[0] as Record<string, unknown>;
    for (const hidden of ['peerDialog', 'dialog', 'peerAddress', 'peerHost', 'remoteAddress', 'remoteHost']) assert.equal(hidden in snapshot, false);
    assert.equal(snapshot.ownership, 'handed-off');
});

test('destination provisional responses are ignored: no cancel and no relay', async () => {
    const f = await fixture();
    await f.gateway.transfer(f.params, 'app');
    assert.deepEqual(f.provisionalSeen, [183]);
    assert.equal(f.cancelled(), 0);
    assert.equal(f.call.ownership, 'handed-off');
});

test('carrier re-INVITE failure acknowledges the answered destination with a rejection before ending it', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = new Error('carrier refused');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /carrier refused/);
    assert.equal(f.caller.reinvites.length, 1, 'a refused re-INVITE needs no restore');
    assert.equal(f.call.ownership, 'application');
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
    assert.match(f.center.acks[0], /m=audio 0 /);
});

test('carrier ACK-phase failure restores the original media before aborting handoff', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    assert.equal(f.caller.reinvites.length, 2);
    assert.match(f.caller.reinvites[1], /c=IN IP4 10\.0\.0\.3/);
    assert.match(f.caller.reinvites[1], /o=- 100 3 /);
    assert.equal(f.call.ownership, 'application');
    assert.equal(f.center.byes, 1);
});

test('an application renegotiation prevents concurrent handoff or replacement', async () => {
    const f = await fixture();
    const pending = Promise.withResolvers<string>();
    f.caller.reinviteHook = () => pending.promise;
    const renegotiating = f.gateway.reinvite('caller', sdp('10.0.0.3'));
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /renegotiation is in progress/);
    const replacement = new Response();
    await f.gateway.handleInvite(invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement') as never, replacement as never);
    assert.equal(replacement.status, 491);
    pending.resolve(sdp('10.0.0.1'));
    await renegotiating;
    f.caller.reinviteHook = async () => sdp('10.0.0.1');
    await f.gateway.transfer(f.params, 'app');
    assert.equal(f.call.ownership, 'handed-off');
});

test('rejected direct audio restores carrier media instead of reporting a completed handoff', async () => {
    const f = await fixture();
    let first = true;
    f.caller.reinviteHook = async () => {
        if (first) {
            first = false;
            return sdp('10.0.0.1', 0);
        }
        return sdp('10.0.0.1');
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /audio was rejected/);
    assert.equal(f.call.transfer?.state, 'failed');
    assert.equal(f.caller.reinvites.length, 2);
    assert.equal(f.center.byes, 1);
    assert.throws(() => assertDirectMediaAnswer(sdp('10.0.0.2'), sdp('10.0.0.1').replace('RTP/AVP', 'RTP/SAVP')), /Incompatible/);
});

test('handoff status validation rejects corrupt recording metadata and incomplete completion', async () => {
    const f = await fixture();
    const result = await f.gateway.transfer(f.params, 'app');
    assert.equal(isSipTransferStatus(result), true);
    assert.equal(isSipTransferStatus({ ...result, committedAt: undefined }), false);
    assert.equal(isSipTransferStatus({ ...result, recordings: [{ ...result.recordings[0], packets: -1 }] }), false);
    assert.equal(isSipTransferStatus({ ...result, startedAt: 'invalid' }), false);
});

test('offerless re-INVITE from the carrier is fully relayed: peer offer out, ACK answer back as the peer ACK', async () => {
    const f = await handedOff();
    const delayed = new Response();
    f.caller.emit('request', request('INVITE', '', 43), delayed);
    await turn();
    assert.equal(f.center.reinvites.at(-1), '', 'the other leg gets an offerless re-INVITE');
    assert.equal(delayed.status, 200);
    assert.match(delayed.options!.body!, /c=IN IP4 10\.0\.0\.2/);
    assert.equal(f.center.acks.length, 1, 'the peer ACK waits for the carrier ACK answer');
    f.caller.deliverAck(42, sdp('10.0.0.8'));
    await turn();
    assert.equal(f.center.acks.length, 1, 'an unrelated ACK cannot complete the delayed offer');
    f.caller.deliverAck(43, sdp('10.0.0.1'));
    await turn();
    assert.equal(f.center.acks.length, 2);
    assert.match(f.center.acks[1], /c=IN IP4 10\.0\.0\.1/);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.registry.size, 1);
});

test('offerless re-INVITE from the destination relays through the carrier leg', async () => {
    const f = await handedOff();
    const delayed = new Response();
    f.center.emit('request', request('INVITE', '', 7), delayed);
    await turn();
    assert.equal(f.caller.reinvites.at(-1), '');
    assert.equal(delayed.status, 200);
    f.center.deliverAck(7, sdp('10.0.0.2', 45000));
    await turn();
    assert.equal(f.caller.acks.length, 1);
    assert.match(f.caller.acks[0], /c=IN IP4 10\.0\.0\.2/);
});

test('an offerless relay whose ACK never arrives is bounded, acknowledges the peer with a rejection and ends the call', async () => {
    const f = await handedOff({ timeout: 20 });
    const delayed = new Response();
    f.caller.emit('request', request('INVITE', '', 43), delayed);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.center.acks.length, 2, 'the real handoff ACK plus one rejection of the unanswered relayed offer');
    assert.match(f.center.acks[1], /m=audio 0 /);
    assert.ok(f.log.indexOf('center:ack') < f.log.indexOf('center:bye'), 'peer is ACKed before BYE');
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('an offerless relay with an empty ACK body rejects the peer offer and ends the call', async () => {
    const f = await handedOff();
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    f.caller.deliverAck(43, '');
    await turn();
    await turn();
    assert.match(f.center.acks.at(-1)!, /m=audio 0 /);
    assert.equal(f.registry.size, 0);
});

test('paired SDP negotiation rejects glare and accepts bodyless UPDATE refreshes', async () => {
    const f = await handedOff();
    const pending = Promise.withResolvers<string>();
    f.caller.reinviteHook = () => pending.promise;
    f.center.emit('request', request('INVITE', sdp('10.0.0.2')), new Response());
    await turn();
    const glare = new Response();
    f.caller.emit('request', request('INVITE', sdp('10.0.0.1'), 44), glare);
    await turn();
    assert.equal(glare.status, 491);
    const refresh = new Response();
    f.caller.emit('request', request('UPDATE', ''), refresh);
    await turn();
    assert.equal(refresh.status, 200);
    assert.equal(f.center.reinvites.length, 0, 'a refresh is never relayed');
    pending.resolve(sdp('10.0.0.1'));
    await turn();
});

test('failed application dialog replacement restores media and keeps its existing episode', async () => {
    const f = await fixture();
    f.failReplacement();
    const response = f.replacementResponse();
    await f.gateway.handleInvite(invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement') as never, response as never);
    assert.equal(response.status, 502);
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.dialog, f.caller);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.requests.filter(r => r.method === 'sip.reinvite').length, 2);
});

test('duplicate transfer IDs dial once and concurrent different transfers conflict', async () => {
    const f = await fixture();
    let release!: () => void;
    f.delayDial(
        () =>
            new Promise<void>(resolve => {
                release = resolve;
            })
    );
    const first = f.gateway.transfer(f.params, 'app');
    const retry = f.gateway.transfer(f.params, 'app');
    await assert.rejects(f.gateway.transfer({ ...f.params, transferId: 'other' }, 'app'), /in progress/);
    await turn();
    release();
    const [a, b] = await Promise.all([first, retry]);
    assert.deepEqual(a, b);
    assert.deepEqual(await f.gateway.transfer(f.params, 'app'), a);
    assert.equal(f.dials(), 1);
    await assert.rejects(f.gateway.transfer(f.params, 'other-owner'), /another owner/);
});

test('recording-stop failure never switches the carrier or commits handoff', async () => {
    const f = await fixture();
    f.failRecording();
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /recorder unavailable/);
    assert.equal(f.caller.reinvites.length, 0);
    assert.equal(f.call.ownership, 'application');
    assert.equal(f.call.transfer?.state, 'failed');
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 1);
    assert.ok(!f.log.includes('delete-media'));
    assert.ok(f.log.indexOf('center:ack') < f.log.indexOf('center:bye'), 'the answered destination is ACKed before BYE');
});

test('caller BYE during setup abandons the answered destination and never resurrects the call', async () => {
    const f = await fixture();
    let release!: () => void;
    f.delayRecording(
        () =>
            new Promise<void>(resolve => {
                release = resolve;
            })
    );
    const transfer = f.gateway.transfer(f.params, 'app');
    await turn();
    await turn();
    f.caller.emit('ended', 'bye');
    release();
    await assert.rejects(transfer, /ended during handoff/);
    assert.equal(f.registry.size, 0);
    assert.equal(f.center.byes, 1);
    assert.equal(f.caller.byes, 0);
});

test('paired BYE terminates the other dialog exactly once', async () => {
    const f = await handedOff();
    f.center.emit('ended', 'bye');
    f.center.emit('ended', 'bye');
    f.caller.emit('ended', 'bye');
    await turn();
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(f.registry.size, 0);
});

test('gateway bye ends both legs of a handed-off call once', async () => {
    const f = await handedOff();
    await f.gateway.bye('caller', 'test');
    await assert.rejects(f.gateway.bye('caller'), /not found/);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
    assert.equal(f.registry.size, 0);
});

test('a fenced leg is never commanded: bye skips it and reports an unknown outcome', async () => {
    const f = await handedOff();
    f.center.isFenced = true;
    await assert.rejects(f.gateway.bye('caller'), (err: unknown) => err instanceof NativeOperationError && err.uncertain);
    assert.equal(f.center.byes, 0);
    assert.equal(f.caller.byes, 1);
    const g = await fixture();
    g.caller.isFenced = true;
    await assert.rejects(g.gateway.transfer(g.params, 'app'), (err: unknown) => err instanceof NativeOperationError && err.uncertain);
    assert.equal(g.dials(), 0);
    assert.equal(g.call.ownership, 'application');
});

test('a fenced destination during cleanup is left alone and the transfer reports an unknown outcome', async () => {
    const f = await fixture();
    f.failRecording();
    f.delayDial(async () => {
        f.center.isFenced = true;
    });
    await assert.rejects(f.gateway.transfer(f.params, 'app'), (err: unknown) => err instanceof NativeOperationError && err.uncertain);
    assert.equal(f.center.byes, 0);
    assert.equal(f.center.acks.length, 0);
});

test('transfers are refused while draining', async () => {
    const lifecycle = new GatewayLifecycle({ maxWaitMs: 1000, cleanupTimeoutMs: 10, activeResources: () => 1, stop: async () => {} });
    const f = await fixture({ lifecycle });
    void lifecycle.drain('test');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /shutting down|draining/i);
    assert.equal(f.dials(), 0);
});

test('paired renegotiation relays remote media without asking the application', async () => {
    const f = await handedOff();
    const before = f.requests.length;
    const response = new Response();
    f.center.emit('request', request('INVITE', sdp('10.0.0.9', 45001)), response);
    await turn();
    assert.equal(response.status, 200);
    assert.match(f.caller.reinvites.at(-1)!, /c=IN IP4 10\.0\.0\.9/);
    assert.equal(f.requests.length, before);
});

test('known-dialog REFER returns locally and a late center BYE cannot end the returned call', async () => {
    const f = await handedOff();
    const response = new Response();
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), response);
    await turn();
    await turn();
    assert.equal(response.status, 202);
    assert.equal(f.call.ownership, 'application');
    assert.equal(f.call.peerDialog, undefined);
    const returned = f.requests.findLast(r => r.method === 'sip.invite')!.params;
    assert.equal(returned.logicalCallId, f.call.logicalCallId);
    assert.equal(returned.returning, true);
    assert.equal(f.dials(), 1);
    assert.ok(f.center.requests.some(r => r.method === 'NOTIFY' && r.body!.includes('200 OK')));
    f.center.emit('ended', 'bye');
    await turn();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 1, 'the old destination leg is ended by the gateway after return');
});

test('ordinary referred INVITEs remain new calls even with matching caller identity', async () => {
    const f = await handedOff();
    await f.gateway.handleInvite(
        invite({ 'referred-by': '<sip:center@center.example>' }, 'new-call') as never,
        new Response(new Dialog('new-call')) as never
    );
    assert.equal(f.registry.size, 2);
    assert.notEqual(f.registry.get('new-call')?.logicalCallId, f.call.logicalCallId);
});

test('Replaces rejects unmatched tags and unauthorized source addresses, scoring only invalid and unauthorized', async () => {
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL: 'enforce' } as never));
    const observed: unknown[][] = [];
    const original = firewall.observe.bind(firewall);
    firewall.observe = ((...args: Parameters<SipFirewall['observe']>) => {
        observed.push(args);
        return original(...args);
    }) as SipFirewall['observe'];
    const f = await handedOff({ firewall });
    f.call.peerAddresses = ['10.0.0.2'];
    for (const [header, address, status] of [
        ['center;to-tag=wrong;from-tag=center-tag', '10.0.0.2', 481],
        ['center;to-tag=center-gateway-tag;from-tag=center-tag', '10.0.0.8', 403],
        ['not a replaces header', '10.0.0.8', 400],
        ['', '10.0.0.8', 400],
        ['   ', '10.0.0.8', 400]
    ] as const) {
        const response = new Response();
        await f.gateway.handleInvite(invite({ replaces: header }, 'replacement', address) as never, response as never);
        assert.equal(response.status, status);
    }
    assert.equal(f.registry.size, 1);
    const byReason = Object.fromEntries(observed.map(args => [args[2], args]));
    assert.equal(byReason['unknown-replaces'][4], true, 'unknown Replaces is flagged as a replacement observation');
    assert.equal(byReason['unauthorized-replaces'][0], '10.0.0.8');
    assert.notEqual(byReason['unauthorized-replaces'][4], true);
    assert.notEqual(byReason['invalid-replaces'][4], true);
});

test('Replaces from an outbound leg is authorized against the configured destination host', async () => {
    const f = await handedOff();
    assert.equal(f.call.peerAddress, undefined, 'outbound legs have no observed source');
    assert.equal(f.call.peerHost, 'center.example');
    f.call.peerHost = '10.0.0.2';
    const ok = f.replacementResponse(new Dialog('replacement', 'rep-local', 'rep-remote'));
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        ok as never
    );
    assert.equal(ok.answered !== undefined, true);
});

test('SDP relay preserves session identity and large origin versions without precision loss', () => {
    const result = relaySdp(sdp('10.0.0.2'), sdp('10.0.0.3', 40000, '9007199254740993'));
    assert.match(result, /o=- 100 9007199254740994 IN IP4 10\.0\.0\.3/);
    assert.match(result, /c=IN IP4 10\.0\.0\.2/);
    assert.throws(() => relaySdp(sdp('10.0.0.2').replace('m=audio', 'm=video'), sdp('10.0.0.3')), /media-section/);
    assert.throws(() => parseReplaces('caller;to-tag=x;to-tag=y;from-tag=z'), /Duplicate/);
    assert.match(rejectSdpOffer(sdp('10.0.0.2')), /m=audio 0 /);
});

test('Refer-To parsing handles name-addr, addr-spec and encoded Replaces', () => {
    assert.deepEqual(parseReferTarget('<sip:inbound@gateway.example>'), { uri: 'sip:inbound@gateway.example', replaces: undefined });
    assert.equal(parseReferTarget('sip:inbound@gateway.example;transport=tcp').uri, 'sip:inbound@gateway.example');
    const parsed = parseReferTarget('"Name" <sip:inbound@gateway.example?Replaces=center%3Bto-tag%3Da%3Bfrom-tag%3Db>');
    assert.deepEqual(parsed.replaces, { callId: 'center', toTag: 'a', fromTag: 'b', earlyOnly: false });
    assert.throws(() => parseReferTarget('tel:+15551234567'), /Invalid SIP target/);
    assert.throws(() => parseReferTarget(''), /Invalid SIP target/);
});

test('authorized replacement of a handoff creates one returned call and retires both old legs', async () => {
    const f = await handedOff();
    f.call.peerHost = '10.0.0.2'; // the destination's configured address, as the transfer URI host would resolve
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    assert.equal(f.registry.size, 1);
    assert.equal(f.registry.get('caller'), undefined);
    assert.equal(f.registry.get('replacement')?.logicalCallId, f.call.logicalCallId);
    const returned = f.requests.findLast(r => r.method === 'sip.invite')!.params;
    assert.equal(returned.returning, true);
    assert.equal(returned.previousSessionId, 'caller');
    f.caller.emit('ended', 'bye');
    f.center.emit('ended', 'bye');
    await turn();
    assert.equal(f.registry.size, 1, 'late events from detached legs are ignored');
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('authorized replacement of an application call renegotiates its existing episode', async () => {
    const f = await fixture();
    const replacement = new Dialog('replacement', 'rep-local', 'rep-remote');
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement') as never,
        new Response(replacement) as never
    );
    assert.equal(f.registry.size, 1);
    assert.equal(f.registry.get('caller')?.logicalCallId, f.call.logicalCallId);
    assert.equal(f.registry.get('caller')?.sipCallId, 'replacement');
    assert.equal(f.requests.filter(r => r.method === 'sip.invite').length, 1);
    assert.equal(f.requests.filter(r => r.method === 'sip.reinvite').length, 1);
    assert.equal(f.caller.byes, 1);
    f.caller.emit('ended', 'bye');
    await turn();
    assert.equal(f.registry.size, 1, 'the replaced leg no longer speaks for the call');
});

test('encoded Refer-To Replaces uses standard dialog tags without a special destination URI', async () => {
    const f = await handedOff();
    const response = new Response();
    f.center.emit(
        'request',
        request('REFER', '', 42, {
            'refer-to': '<sip:inbound@gateway.example?Replaces=center%3Bto-tag%3Dcenter-gateway-tag%3Bfrom-tag%3Dcenter-tag>'
        }),
        response
    );
    await turn();
    await turn();
    assert.equal(response.status, 202);
    assert.equal(f.call.ownership, 'application');
    const unknown = new Response();
    f.center.emit(
        'request',
        request('REFER', '', 43, { 'refer-to': '<sip:inbound@gateway.example?Replaces=other%3Bto-tag%3Da%3Bfrom-tag%3Db>' }),
        unknown
    );
    await turn();
    assert.equal(unknown.status, 481);
});

test('failed return admission leaves the direct-media conversation intact', async () => {
    const f = await handedOff();
    f.hub.request = async () => ({ action: 'reject', status: 503 }) as never;
    const response = new Response();
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), response);
    await turn();
    await turn();
    assert.equal(response.status, 202);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.center.byes, 0);
    assert.equal(f.caller.reinvites.length, 1);
    assert.ok(f.center.requests.some(r => r.method === 'NOTIFY' && r.body!.includes('503')));
});

test('ACK deadline prevents late carrier responses from leaving abandoned direct media alive', async () => {
    const f = await fixture({ timeout: 10 });
    const answer = Promise.withResolvers<string>();
    f.caller.reinviteHook = () => answer.promise;
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /deadline expired/);
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
    assert.equal(f.center.acks.length, 1, 'the destination receives exactly one ACK (the rejection)');
    answer.resolve(sdp('10.0.0.1'));
    await turn();
    await turn();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.acks.length, 1, 'a late carrier answer cannot ACK the abandoned destination again');
});

test('operation conflicts map to CONFLICT after native outcome errors', () => {
    assert.deepEqual(controlErrorForCommand(new SipOperationConflictError('busy')), { code: 'CONFLICT', message: 'busy' });
    assert.equal(controlErrorForCommand(new NativeOperationError('x', true))?.code, 'SIGNALING_UNKNOWN');
});

test('a destination that hangs up after sending the return REFER does not end the caller', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'answer', sdp: sdp('10.0.0.3') } as never;
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await turn();
    f.center.emit('ended', 'bye');
    await turn();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.call.peerDialog, undefined, 'the departed destination is detached');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.call.ownership, 'application');
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
});

test('a failed return after the destination left ends the call instead of stranding the caller', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'reject', status: 503 } as never;
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await turn();
    f.center.emit('ended', 'bye');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('a destination answering after the caller left is ACKed with a rejection before BYE', async () => {
    const f = await fixture();
    f.delayDial(async () => {
        f.caller.emit('ended', 'bye');
    });
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.registry.size, 0);
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
    assert.match(f.center.acks[0], /m=audio 0 /);
});

test('a refused return re-INVITE needs no restore and leaves the external conversation working', async () => {
    const f = await handedOff();
    const before = f.caller.reinvites.length;
    f.caller.reinviteFailure = new NativeOperationError('SIP non-success response: 491', false, false, 491);
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.caller.reinvites.length, before + 1, 'no restore re-INVITE after a refused one');
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0);
});

test('internal handoff attempt ids are unique and never derived from the callId', async () => {
    const f = await fixture();
    const attempts = (f.gateway as unknown as { pendingOutboundCalls: Map<string, unknown> }).pendingOutboundCalls;
    attempts.set('handoff:caller', { cancelRequested: false });
    f.caller.reinviteHook = async () => sdp('10.0.0.1');
    assert.equal((await f.gateway.transfer(f.params, 'app')).state, 'completed');
    assert.equal(f.call.ownership, 'handed-off');
    attempts.delete('handoff:caller');
});

test('ending the call mid-relay ACKs the waiting peer before its BYE', async () => {
    const f = await handedOff();
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    assert.equal(f.center.acks.length, 1, 'the peer is waiting for the relayed answer');
    f.caller.emit('ended', 'bye');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.center.acks.length, 2);
    assert.match(f.center.acks[1], /m=audio 0 /);
    assert.ok(f.log.indexOf('center:bye') > f.log.lastIndexOf('center:ack'), 'ACK precedes BYE on the peer');
    assert.equal(f.center.byes, 1);
    assert.equal(f.registry.size, 0);
});

test('an offered relay whose answer cannot be returned ends the call rather than leaving legs on different media', async () => {
    const f = await handedOff();
    const response = new Response();
    response.respond = async () => {
        throw new Error('requester gone');
    };
    f.center.emit('request', request('INVITE', sdp('10.0.0.9', 45001)), response);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('Replaces during a cross-leg operation is refused instead of racing it', async () => {
    const f = await handedOff();
    f.call.peerHost = '10.0.0.2';
    const pending = Promise.withResolvers<string>();
    f.caller.reinviteHook = () => pending.promise;
    f.center.emit('request', request('INVITE', sdp('10.0.0.2')), new Response());
    await turn();
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    assert.equal(response.status, 491);
    assert.equal(f.registry.size, 1);
    pending.resolve(sdp('10.0.0.1'));
    await turn();
});

test('a refused offerless relay answers the requester and keeps the call: 491 for glare, 488 otherwise', async () => {
    for (const [message, status] of [
        [new NativeOperationError('SIP non-success response: 491', false, false, 491), 491],
        [new NativeOperationError('SIP 491: INVITE procedure pending', false, false, 491), 491],
        [new NativeOperationError('SIP 491: INVITE procedure pending'), 488],
        [new NativeOperationError('SIP non-success response: 488', false, false, 488), 488],
        [new NativeOperationError('INVITE procedure pending'), 488],
        [new Error('SIP 491: INVITE procedure pending'), 488]
    ] as const) {
        const f = await handedOff();
        f.center.reinviteFailure = message;
        const response = new Response();
        f.caller.emit('request', request('INVITE', '', 43), response);
        await turn();
        await turn();
        assert.equal(response.status, status);
        assert.equal(f.registry.size, 1);
        assert.equal(f.caller.byes, 0);
        assert.equal(f.center.byes, 0);
        assert.equal(f.center.acks.length, 1, 'no ACK is owed when no offer arrived');
        assert.equal(f.call.ownership, 'handed-off');
    }
});

test('glare on an offered relay is passed through as 491', async () => {
    const f = await handedOff();
    f.center.reinviteFailure = new NativeOperationError('SIP non-success response: 491', false, false, 491);
    const response = new Response();
    f.caller.emit('request', request('INVITE', sdp('10.0.0.1')), response);
    await turn();
    await turn();
    assert.equal(response.status, 491);
    assert.equal(f.registry.size, 1);
});

test('a Replaces return whose destination left while the application was consulted ends the call', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'reject', status: 603 } as never;
    };
    const response = new Response();
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await turn();
    f.center.emit('ended', 'bye');
    gate.resolve();
    await pending;
    await turn();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('a BYE during an outstanding offerless re-INVITE ACKs the peer offer before the BYE', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    f.center.offerlessGate = gate.promise;
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    f.caller.emit('ended', 'bye');
    await turn();
    assert.equal(f.center.byes, 0, 'BYE waits for the owed ACK');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(f.log.indexOf('center:ack') >= 0 && f.log.indexOf('center:ack') < f.log.indexOf('center:bye'));
    assert.equal(f.center.byes, 1);
});

test('REFER on an application-owned call is refused with 405', async () => {
    const f = await fixture();
    const response = new Response();
    f.caller.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), response);
    await turn();
    assert.equal(response.status, 405);
    assert.equal(f.caller.requests.length, 0, 'no NOTIFY');
    assert.equal(f.registry.size, 1);
});

test('Replaces authorization is re-validated after DNS and never scores a resolution failure', async () => {
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL: 'enforce' } as never));
    const observed: string[] = [];
    const original = firewall.observe.bind(firewall);
    firewall.observe = ((...args: Parameters<SipFirewall['observe']>) => {
        observed.push(args[2]);
        return original(...args);
    }) as SipFirewall['observe'];
    const f = await handedOff({ firewall });
    f.call.peerHost = 'unresolvable.invalid';
    const failed = new Response();
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        failed as never
    );
    assert.equal(failed.status, 503);
    assert.deepEqual(observed, []);
    // The dialog ends while the (real) lookup is in flight: the stale match must not be used.
    f.call.peerHost = 'localhost';
    const stale = new Response();
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '127.0.0.1') as never,
        stale as never
    );
    await turn();
    f.center.emit('ended', 'bye');
    await pending;
    assert.equal(stale.status, 481);
});

const gone = () => new NativeOperationError('SIP non-success response: 481', false, false, 481, true);

test('dialog-gone 481 on an offered relay answers the requester and ends the call once', async () => {
    const f = await handedOff();
    f.center.reinviteFailure = gone();
    const response = new Response();
    response.log = f.log;
    f.caller.emit('request', request('INVITE', sdp('10.0.0.1')), response);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(response.status, 488);
    assert.ok(f.log.indexOf('response:488') >= 0 && f.log.indexOf('response:488') < f.log.findIndex(e => e.endsWith(':bye')));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('dialog-gone 481 on an offerless relay answers the requester and ends the call once', async () => {
    const f = await handedOff();
    f.center.reinviteFailure = gone();
    const response = new Response();
    response.log = f.log;
    f.caller.emit('request', request('INVITE', '', 43), response);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(response.status, 488);
    assert.deepEqual(f.center.reinvites, ['']);
    assert.ok(f.log.indexOf('response:488') >= 0 && f.log.indexOf('response:488') < f.log.findIndex(e => e.endsWith(':bye')));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('a 488 or a local 481 refusal (dialogGone false) keeps the call on every relay path', async () => {
    for (const failure of [
        new NativeOperationError('SIP non-success response: 488', false, false, 488),
        new NativeOperationError('dialog terminating', false, false, 481)
    ]) {
        for (const body of [sdp('10.0.0.1'), '']) {
            const f = await handedOff();
            f.center.reinviteFailure = failure;
            const response = new Response();
            f.caller.emit('request', request('INVITE', body, 44), response);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(f.center.reinvites.length, 1, 'the relay reached the center leg');
            assert.equal(f.center.reinvites[0] === '', body === '');
            assert.equal(response.status, 488);
            assert.equal(f.registry.size, 1);
            assert.equal(f.caller.byes, 0);
            assert.equal(f.center.byes, 0);
        }
    }
});

test('dialog-gone 481 on an application reinvite throws InvalidCallStateError and ends the call', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = gone();
    await assert.rejects(f.gateway.reinvite('caller', sdp('10.0.0.3')), /481/);
    await turn();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    const g = await fixture();
    g.caller.reinviteFailure = new NativeOperationError('SIP non-success response: 488', false, false, 488);
    await assert.rejects(g.gateway.reinvite('caller', sdp('10.0.0.3')), /488/);
    await turn();
    assert.equal(g.registry.size, 1);
    assert.equal(g.caller.byes, 0);
});

test('dialog-gone carrier rejection during transfer ACKs the destination, then BYEs it and the carrier once', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = gone();
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /481/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(
        f.log.filter(entry => /:(ack|bye)$/.test(entry)),
        ['center:ack', 'center:bye', 'caller:bye']
    );
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('a non-gone carrier rejection during transfer keeps the call', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = new NativeOperationError('SIP non-success response: 488', false, false, 488);
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /488/);
    await turn();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
});

test('dialog-gone carrier rejection on a return ends the whole call once', async () => {
    const f = await handedOff();
    f.caller.reinviteFailure = gone();
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
    assert.ok(f.log.indexOf('center:notify-503') >= 0 && f.log.indexOf('center:notify-503') < f.log.indexOf('center:bye'), 'NOTIFY precedes BYE');
});

test('a NOTIFY 481 on either leg is not dialog-gone and keeps the call', async () => {
    for (const leg of ['caller', 'center'] as const) {
        const f = await handedOff();
        f[leg].request = async () => {
            throw new NativeOperationError('SIP non-success response: 481', false, false, 481, false);
        };
        f[leg].emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(f.caller.byes, 0);
        // The return itself may legitimately retire the external leg; only the carrier must stay connected.
        assert.equal(f.registry.size, 1);
    }
});

test('a single-leg dialog-gone call is removed synchronously so a racing app BYE sees NOT_FOUND', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = gone();
    await assert.rejects(f.gateway.reinvite('caller', sdp('10.0.0.3')), /481/);
    assert.equal(f.registry.size, 0);
    await assert.rejects(f.gateway.bye('caller'), /not found/i);
    await turn();
    assert.equal(f.caller.byes, 1);
});

const noMediaSdp = 'v=0\r\no=- 1 1 IN IP4 10.0.0.2\r\ns=-\r\nt=0 0\r\n';

test('rejectSdpOffer never throws: an offer without media is rejected with a minimal valid SDP', () => {
    for (const offer of ['', 'garbage', noMediaSdp]) {
        const rejection = rejectSdpOffer(offer);
        assert.match(rejection, /^v=0\r\no=- 0 0 IN IP4 0\.0\.0\.0\r\ns=-\r\nc=IN IP4 0\.0\.0\.0\r\nt=0 0\r\n$/);
    }
});

test('a failed transfer whose destination offer has no media ACKs it before the BYE', async () => {
    const f = await fixture();
    f.center.remoteSdp = noMediaSdp;
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
});

test('an offerless relay whose peer offer has no media ACKs the peer before the BYE', async () => {
    const f = await handedOff();
    f.center.remoteSdp = noMediaSdp;
    const response = new Response();
    f.caller.emit('request', request('INVITE', '', 43), response);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(response.status, 488);
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
    assert.equal(f.registry.size, 0);
});

test('a destination ACK refused once is retried and succeeds before the BYE', async () => {
    const f = await fixture();
    f.center.ackFailure = new NativeOperationError('ACK refused');
    f.center.ackFailureLimit = 2; // the answer ACK, then the first rejection ACK
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:ack', 'center:ack', 'center:bye']
    );
    assert.equal(f.center.acks.length, 1);
    assert.equal(f.center.byes, 1);
});

test('an always-refused destination ACK defers the BYE until the peer has given up waiting for it', async () => {
    const f = await fixture({ ackGiveUpMs: 80 });
    f.center.ackFailure = new NativeOperationError('ACK refused');
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.center.byes, 0, 'no BYE without the ACK the peer is owed');
    assert.equal(f.center.acks.length, 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.center.byes, 1, 'BYE follows once the ACK window has passed');
});

test('a deferred BYE is dropped when the leg ends first', async () => {
    const f = await fixture({ ackGiveUpMs: 60 });
    f.center.ackFailure = new NativeOperationError('ACK refused');
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    f.center.isEnded = true;
    f.center.emit('ended', 'bye');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.center.byes, 0);
});

test('an uncertain destination ACK fences the leg and it is never commanded', async () => {
    const f = await fixture();
    f.center.ackFailure = new NativeOperationError('ACK unknown', true);
    f.center.fenceOnAckFailure = true;
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.center.byes, 0);
});

test('a peer ACK refused once on an offerless relay is retried, then the call ends with ACK before BYE', async () => {
    const f = await handedOff();
    f.center.acks.length = 0;
    f.center.ackFailure = new NativeOperationError('ACK refused');
    f.center.ackFailureLimit = 2;
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    f.caller.deliverAck(43, sdp('10.0.0.1'));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
    assert.ok(f.log.indexOf('center:bye') > f.log.lastIndexOf('center:ack'), 'a written ACK precedes the BYE');
    assert.equal(f.center.acks.length, 1, 'the retried rejection ACK was written');
});

test('an always-refused peer ACK on an offerless relay ends the call but defers that leg BYE', async () => {
    const f = await handedOff();
    f.center.ackFailure = new NativeOperationError('ACK refused');
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    f.caller.deliverAck(43, sdp('10.0.0.1'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0, 'not BYEd without its ACK');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.center.byes, 1);
});

test('a BYE refused once after registry removal is retried and sent', async () => {
    const f = await handedOff();
    f.caller.byeFailure = new NativeOperationError('control operation capacity', false, true);
    f.caller.byeFailureLimit = 1;
    f.center.emit('ended', 'bye');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1, 'the surviving leg is still ended');
});

test('a BYE that is refused every time gives up after the bounded retries', async () => {
    const f = await handedOff();
    let attempts = 0;
    f.caller.bye = async () => {
        attempts++;
        throw new NativeOperationError('control operation capacity', false, true);
    };
    f.center.emit('ended', 'bye');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(attempts, 4, 'one attempt plus three retries');
    assert.equal(f.registry.size, 0);
});

test('an uncertain cross-leg re-INVITE ends the call once, never commanding a fenced leg', async () => {
    for (const offerless of [false, true]) {
        for (const fenced of [true, false]) {
            const f = await handedOff();
            f.center.reinviteFailure = new NativeOperationError('x', true);
            f.center.fenceOnReinviteFailure = fenced;
            const response = new Response();
            response.log = f.log;
            f.caller.emit('request', request('INVITE', offerless ? '' : sdp('10.0.0.1'), 43), response);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(response.status, 488);
            assert.equal(f.registry.size, 0);
            assert.equal(f.caller.byes, 1);
            assert.equal(f.center.byes, fenced ? 0 : 1);
        }
    }
});

test('a Replaces return whose caller hung up while the application was consulted is refused with 603', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'answer', sdp: sdp('10.0.0.3') } as never;
    };
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await turn();
    f.caller.emit('ended', 'bye');
    gate.resolve();
    await pending;
    await turn();
    assert.deepEqual(response.statuses, [603]);
    assert.equal(response.answered, undefined);
    assert.equal(f.registry.size, 0);
    assert.equal(f.center.byes, 1);
    assert.equal(replacement.byes, 0);
    assert.ok(
        f.events.some(event => JSON.stringify(event).includes('replacement')),
        'the application is told the new leg ended'
    );
});

test('a Replaces return whose caller hung up during the answer tears down the new dialog', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    response.answerGate = gate.promise;
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    f.caller.emit('ended', 'bye');
    await turn();
    gate.resolve();
    await pending;
    await turn();
    assert.equal(f.registry.size, 0);
    assert.equal(replacement.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('a 481 to the progress NOTIFY ends the REFER subscription: no final NOTIFY, the call survives', async () => {
    const f = await handedOff();
    let notifies = 0;
    f.center.request = async () => {
        notifies++;
        throw new NativeOperationError('SIP non-success response: 481', false, false, 481, false);
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(notifies, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.registry.size, 1);
});

test('a NOTIFY that times out (COMPLETED error, status 0) ends the REFER subscription: no final NOTIFY, the call survives', async () => {
    const f = await handedOff();
    let notifies = 0;
    f.center.request = async () => {
        notifies++;
        throw new NativeOperationError('Timer F expired', false, false, 0, false, true);
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(notifies, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.registry.size, 1);
});

test('an application disconnect during post-commit media cleanup cannot cancel or BYE the committed destination', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayDestroy(() => gate.promise);
    const transfer = f.gateway.transfer(f.params, 'app');
    for (let i = 0; i < 50 && !f.events.some(event => (event as { event?: string }).event === 'sip.transferred'); i++) await turn();
    assert.ok(
        f.events.some(event => (event as { event?: string }).event === 'sip.transferred'),
        'commit published'
    );
    await f.gateway.terminateCallsForControlConnection('app');
    assert.equal(f.cancelled(), 0, 'the committed destination attempt is no longer cancellable');
    assert.equal(f.center.byes, 0);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.registry.size, 1);
    gate.resolve();
    assert.equal((await transfer).state, 'completed');
    assert.equal(f.registry.size, 1);
    assert.equal(f.center.byes, 0);
});

const sentEvents = (f: Fixture, name: string) => f.events.filter(event => (event as { event?: string }).event === name);

test('an uncertain carrier re-INVITE during transfer is terminal: ACK then BYE the destination, the fenced carrier is never commanded', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = new NativeOperationError('Native outcome unknown', true);
    f.caller.fenceOnReinviteFailure = true;
    await assert.rejects(f.gateway.transfer(f.params, 'app'), (err: unknown) => err instanceof NativeOperationError && err.uncertain);
    assert.equal(f.registry.size, 0);
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
    assert.match(f.center.acks[0], /m=audio 0 /, 'the destination offer is rejected');
    assert.equal(f.caller.byes, 0);
    assert.equal(f.caller.reinvites.length, 1, 'no restore re-INVITE');
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('the handoff timer ends the call (registry first) even when the queued carrier BYE fails at a fence', async () => {
    const f = await fixture({ timeout: 20 });
    f.caller.reinviteHook = () => new Promise<string>(() => undefined);
    f.caller.bye = async () => {
        assert.equal(f.registry.size, 0, 'removal precedes every command');
        throw new NativeOperationError('Native call is ended or uncertain', true);
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.registry.size, 0);
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('an uncertain carrier re-INVITE on a REFER return ends the call: NOTIFY then BYE the destination, carrier untouched', async () => {
    const f = await handedOff();
    f.caller.reinviteFailure = new NativeOperationError('Native outcome unknown', true);
    f.caller.fenceOnReinviteFailure = true;
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 0, 'the fenced carrier is never commanded');
    assert.equal(f.center.byes, 1);
    assert.ok(f.log.indexOf('center:notify-503') >= 0 && f.log.indexOf('center:notify-503') < f.log.indexOf('center:bye'), 'NOTIFY precedes BYE');
    assert.ok(sentEvents(f, 'sip.terminated').length >= 1, 'the application is told the call ended');
});

test('an owner that disconnects during the Replaces answer write gets the replacement BYEd and the original pair keeps its state', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    response.answerGate = gate.promise;
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.call.ownership, 'returning');
    f.hub.isConnected = () => false;
    await f.gateway.terminateCallsForControlConnection('app');
    gate.resolve();
    await pending;
    await turn();
    assert.equal(replacement.byes, 1, 'the replacement dialog is ended');
    assert.equal(f.registry.get('replacement'), undefined);
    assert.equal(f.registry.get('caller'), f.call);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0);
});

test('a Replaces return whose owner disconnected before the answer is refused with 603 and the pair stays handed off', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'answer', sdp: sdp('10.0.0.3') } as never;
    };
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await turn();
    f.hub.isConnected = () => false;
    gate.resolve();
    await pending;
    assert.deepEqual(response.statuses, [603]);
    assert.equal(response.answered, undefined);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0);
});

test('distinct rejected requests sharing Call-ID and CSeq each score; a redelivered request id scores once', async () => {
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL: 'enforce' } as never));
    const f = await handedOff({ firewall });
    const bad = (requestId: string) => ({ ...invite({ replaces: 'not a replaces header' }, 'same-call', '10.0.0.8', 'INVITE', 7), requestId });
    for (const requestId of ['req-1', 'req-2', 'req-2']) await f.gateway.handleInvite(bad(requestId) as never, new Response() as never);
    assert.equal(firewall.status().counters.observations, 2);
});

test('an uncertain restore re-INVITE after a refused destination ACK leaves nothing registered and terminates once', async () => {
    const f = await fixture();
    let invites = 0;
    f.caller.reinviteHook = async () => {
        if (++invites === 1) return sdp('10.0.0.1');
        f.caller.isFenced = true;
        throw new NativeOperationError('Native outcome unknown', true);
    };
    f.center.ackFailure = new NativeOperationError('ACK refused');
    f.center.ackFailureLimit = 1;
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.registry.size, 0, 'the call is not left registered');
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(f.caller.byes, 0, 'the fenced carrier is never commanded');
    assert.equal(f.caller.reinvites.length, 2);
});

test('a REFER return whose destination left and whose restore is uncertain does not strand the call in returning', async () => {
    const f = await handedOff();
    let invites = 0;
    f.caller.reinviteHook = async () => {
        if (++invites === 1) {
            f.center.isEnded = true;
            f.center.emit('ended', 'bye');
            f.hub.isConnected = () => false;
            return sdp('10.0.0.1');
        }
        f.caller.isFenced = true;
        throw new NativeOperationError('Native outcome unknown', true);
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 0);
});

test('a single-leg application BYE refused every time still removes the call and reports it once', async () => {
    const f = await fixture();
    f.caller.bye = async () => {
        throw new NativeOperationError('control operation capacity', false, true);
    };
    await assert.rejects(f.gateway.bye('caller', 'app-hangup'), (err: unknown) => err instanceof NativeOperationError && err.unavailable);
    assert.equal(f.registry.size, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a BYE refused through the whole extended schedule is retried every time', async () => {
    const f = await fixture({ retryDelays: [1, 1, 1, 1, 1, 1, 1] });
    let attempts = 0;
    f.caller.bye = async () => {
        attempts++;
        throw new NativeOperationError('control operation capacity', false, true);
    };
    await assert.rejects(f.gateway.bye('caller'));
    assert.equal(attempts, 8, 'one attempt plus seven retries');
});

test('after the handoff deadline the terminal event and the transfer result do not wait for the hung carrier re-INVITE', async () => {
    const f = await fixture({ timeout: 20 });
    const gate = Promise.withResolvers<void>();
    f.caller.reinviteHook = async () => {
        await gate.promise;
        return sdp('10.0.0.1');
    };
    const realBye = f.caller.bye.bind(f.caller);
    f.caller.bye = async () => {
        await gate.promise; // the native per-context queue runs the BYE behind the re-INVITE
        return realBye();
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.registry.size, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(f.caller.byes, 0, 'the carrier BYE is still queued behind the re-INVITE');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.caller.byes, 1);
});

test('shutdown wakes a sleeping BYE retry and schedules nothing afterwards', async () => {
    const f = await fixture({ retryDelays: [60_000, 60_000] });
    let attempts = 0;
    f.caller.bye = async () => {
        attempts++;
        throw new NativeOperationError('control operation capacity', false, true);
    };
    const ending = f.gateway.bye('caller').catch(() => undefined);
    await turn();
    assert.equal(attempts, 1);
    assert.equal((f.gateway as any).retrySleeps.size, 1);
    await f.gateway.shutdown();
    await ending;
    assert.equal(attempts, 1, 'no retry after shutdown');
    assert.equal((f.gateway as any).retrySleeps.size, 0);
    // A refused ACK during shutdown does not schedule a deferred BYE either.
    (f.gateway as any).deferBye(new Dialog(), undefined, Date.now());
    assert.equal((f.gateway as any).deferredByes.size, 0);
});

const eventNames = (f: Fixture) => f.events.map(event => (event as { event?: string }).event);

test('a stale offerless relay failing after its call ended never tears down a new call with the same id', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    f.center.offerlessGate = gate.promise;
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    f.caller.emit('ended', 'bye');
    await turn();
    assert.equal(f.registry.get('caller'), undefined);
    const successor = new Dialog('caller', 'new-local', 'new-remote');
    await f.gateway.handleInvite(invite() as never, new Response(successor) as never);
    await turn();
    const next = f.registry.get('caller');
    assert.ok(next && next !== f.call, 'a new call reuses the id');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.registry.get('caller'), next);
    assert.equal(successor.byes, 0);
});

test('an uncertain 202 to the return REFER ends the call: usable leg BYEd, fenced leg never commanded, one terminated', async () => {
    const f = await handedOff();
    f.events.length = 0;
    const response = new Response();
    response.respond = async () => {
        f.center.isFenced = true;
        throw new NativeOperationError('Native outcome unknown', true);
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), response);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
});

test('an uncertain final NOTIFY on the retained carrier ends the call without sip.answered', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.request = async (method: string, options: { body?: string } = {}) => {
        f.caller.requests.push({ method, ...options });
        if (options.body?.includes('200 OK')) {
            f.caller.isFenced = true;
            throw new NativeOperationError('Native outcome unknown', true);
        }
    };
    f.caller.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 0, 'the fenced carrier is never commanded');
    assert.equal(f.center.byes, 1);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a retained leg hanging up during the final NOTIFY never yields sip.answered after sip.bye', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    f.center.request = async (method: string, options: { body?: string } = {}) => {
        f.center.requests.push({ method, ...options });
        if (options.body?.includes('200 OK')) await gate.promise;
    };
    f.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' }), new Response());
    await new Promise(resolve => setTimeout(resolve, 10));
    f.caller.emit('ended', 'bye');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 30));
    const names = eventNames(f);
    assert.ok(names.includes('sip.bye'));
    assert.ok(!names.includes('sip.answered') || names.indexOf('sip.answered') < names.indexOf('sip.bye'));
});

test('a Replaces return publishes sip.answered before the old-leg cleanup wait, so a later bye follows it', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    f.caller.bye = async () => {
        await gate.promise;
        f.caller.byes++;
    };
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        new Response(replacement) as never
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    replacement.emit('ended', 'bye');
    gate.resolve();
    await pending;
    await turn();
    const names = eventNames(f);
    assert.ok(names.indexOf('sip.answered') >= 0 && names.indexOf('sip.answered') < names.indexOf('sip.bye'));
});

test('a Replaces return whose named destination left while the application was consulted is refused with 603', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'answer', sdp: sdp('10.0.0.3') } as never;
    };
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await turn();
    f.center.emit('ended', 'bye');
    gate.resolve();
    await pending;
    await turn();
    assert.deepEqual(response.statuses, [603]);
    assert.equal(response.answered, undefined);
});

test('a Replaces return whose named destination left during the answer tears down the replacement', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    response.answerGate = gate.promise;
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    f.center.emit('ended', 'bye');
    gate.resolve();
    await pending;
    await turn();
    assert.equal(f.registry.get('replacement'), undefined);
    assert.equal(replacement.byes, 1);
});

test('a cancelled late-offer outbound that the destination still answers is ACKed with a rejection before its BYE', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    const outbound = f.gateway.createOutbound({
        requestUri: 'sip:center@center.example',
        sdp: '',
        controlConnectionId: 'app',
        outboundAttemptId: 'attempt-1'
    } as never);
    const rejected = assert.rejects(outbound, /cancelled/);
    await turn();
    await turn();
    await f.gateway.cancelOutbound('attempt-1', 'app');
    gate.resolve();
    await rejected;
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
    assert.match(f.center.acks[0], /m=audio 0 /);
});

const refer = () => request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>' });
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const unknownNotify = (dialog: Dialog, match: string) => {
    dialog.request = async (method: string, options: { body?: string } = {}) => {
        dialog.requests.push({ method, ...options });
        if (options.body?.includes(match)) {
            dialog.isFenced = true;
            throw new NativeOperationError('Native outcome unknown', true);
        }
    };
};

test('a declined REFER return whose failure NOTIFY is UNKNOWN ends the call: usable carrier BYEd once, fenced destination never commanded', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.hub.request = async () => ({ action: 'reject', status: 486 }) as never;
    unknownNotify(f.center, '503');
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a fenced progress NOTIFY followed by a declined return ends the call instead of keeping a fenced peer', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.hub.request = async () => ({ action: 'reject', status: 486 }) as never;
    unknownNotify(f.center, '100 Trying');
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a failed return with a healthy peer 481 on the NOTIFY keeps the pair (subscription-scoped)', async () => {
    const f = await handedOff();
    f.hub.request = async () => ({ action: 'reject', status: 486 }) as never;
    f.center.request = async (method: string, options: { body?: string } = {}) => {
        f.center.requests.push({ method, ...options });
        throw new NativeOperationError('SIP non-success response: 481', false, false, 481, false);
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.caller.byes, 0);
});

test('a definitely refused REFER 202 after the destination hung up ends the call: carrier BYEd once, one terminated', async () => {
    const f = await handedOff();
    f.events.length = 0;
    const gate = Promise.withResolvers<void>();
    const response = new Response();
    response.respond = async () => {
        await gate.promise;
        throw new NativeOperationError('REFER response refused', false);
    };
    f.center.emit('request', refer(), response);
    await turn();
    f.center.emit('ended', 'bye');
    await turn();
    assert.equal(f.call.peerDialog, undefined);
    gate.resolve();
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a definitely refused REFER 202 with the destination still attached restores handed-off', async () => {
    const f = await handedOff();
    const response = new Response();
    response.respond = async () => {
        throw new NativeOperationError('REFER response refused', false);
    };
    f.center.emit('request', refer(), response);
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.caller.byes, 0);
});

test('a REFER return whose carrier answers 200 with rejected audio restores media and reports 503', async () => {
    const f = await handedOff();
    f.events.length = 0;
    let first = true;
    f.caller.reinviteHook = async () => {
        if (first) {
            first = false;
            return sdp('10.0.0.1', 0);
        }
        return sdp('10.0.0.1');
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    // The handoff re-INVITE, the rejected return re-INVITE, then the restore of the destination's media.
    assert.equal(f.caller.reinvites.length, 3, 'the carrier is restored to its previous media');
    assert.match(f.caller.reinvites[2], /c=IN IP4 10\.0\.0\.2/);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.registry.size, 1);
    assert.equal(f.center.byes, 0);
    const notifies = f.center.requests.filter(r => r.method === 'NOTIFY').map(r => r.body ?? '');
    assert.ok(notifies.some(body => body.includes('503')));
    assert.ok(!notifies.some(body => body.includes('200 OK')));
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
});

test('a Replaces from an equivalent IPv6 spelling of the configured destination is authorized', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = undefined;
    f.call.peerHost = '2001:0db8:0:0:0:0:0:1';
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '2001:db8::1') as never,
        response as never
    );
    assert.ok(!response.statuses.includes(403), `statuses ${response.statuses}`);
    assert.ok(response.answered, 'the replacement was answered');
});

test("a reused callId never inherits the previous call's pending transfer or conflicts with it", async () => {
    for (const transferId of ['transfer-1', 'transfer-2']) {
        const f = await fixture();
        const gate = Promise.withResolvers<void>();
        f.delayDestroy(() => gate.promise);
        const first = f.gateway.transfer(f.params, 'app');
        await settle(10);
        assert.equal(f.call.ownership, 'handed-off');
        await f.gateway.bye('caller', 'carrier-hangup');
        const second = new Dialog('caller', 'gateway-tag-2', 'caller-tag-2');
        second.name = 'caller2';
        second.log = f.log;
        // The first call's media teardown is still pending, so its endpoint stays reserved: the reused call binds another.
        f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.3', 41000) }) as never;
        await f.gateway.handleInvite(invite() as never, new Response(second) as never);
        await turn();
        const callB = f.registry.get('caller')!;
        assert.notEqual(callB, f.call);
        second.reinviteHook = async () => sdp('10.0.0.1');
        const dialsBefore = f.dials();
        const next = f.gateway.transfer({ ...f.params, transferId }, 'app');
        await settle(10);
        assert.equal(f.dials(), dialsBefore + 1, `${transferId}: the new call starts its own transfer`);
        assert.equal(callB.ownership, 'handed-off');
        gate.resolve();
        const [a, b] = await Promise.all([first, next]);
        assert.notEqual(b.logicalCallId, a.logicalCallId);
        assert.equal(b.transferId, transferId);
    }
});

test('the same call and transferId still share one transfer', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    const one = f.gateway.transfer(f.params, 'app');
    const two = f.gateway.transfer(f.params, 'app');
    await settle(10);
    gate.resolve();
    const [a, b] = await Promise.all([one, two]);
    assert.equal(a.transferId, b.transferId);
    assert.equal(f.dials(), 1);
});

test('a CANCEL whose retries ran out leaves setup pending: the destination that answers later is ACKed and BYEd', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    f.failCancel(new NativeOperationError('cancel refused', false));
    const outbound = f.gateway.createOutbound({
        requestUri: 'sip:center@center.example',
        sdp: '',
        controlConnectionId: 'app',
        outboundAttemptId: 'attempt-1'
    } as never);
    const rejected = assert.rejects(outbound, /cancelled/);
    await turn();
    await turn();
    await assert.rejects(f.gateway.cancelOutbound('attempt-1', 'app'));
    gate.resolve();
    await rejected;
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye']
    );
});

test('an outbound setup that fails at the native deadline is cancelled once more', async () => {
    const f = await fixture();
    f.delayDial(async () => {
        throw new NativeOperationError('Outbound setup deadline', true);
    });
    await assert.rejects(
        f.gateway.createOutbound({
            requestUri: 'sip:center@center.example',
            sdp: '',
            controlConnectionId: 'app',
            outboundAttemptId: 'attempt-2'
        } as never),
        /deadline/
    );
    await turn();
    assert.equal(f.cancelled(), 1);
    assert.equal(f.center.byes, 0);
});

test('the handoff media guard is bound to the endpoint validated for the source call', async () => {
    const f = await fixture();
    await f.gateway.transfer(f.params, 'app');
    assert.deepEqual(f.sources, [{ endpointId: 'endpoint-a', sdp: sdp('10.0.0.3') }]);
});

test('a destination bodyless UPDATE whose 200 is UNKNOWN ends the pair: carrier BYEd, destination never commanded, one terminated', async () => {
    const f = await handedOff();
    f.events.length = 0;
    const response = new Response();
    response.respond = async () => {
        f.center.fence();
        throw new NativeOperationError('Native outcome unknown', true);
    };
    f.center.emit('request', request('UPDATE', ''), response);
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a 488 to the requester that is UNKNOWN after the peer rejects a relayed re-INVITE ends the pair once', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.center.reinviteFailure = new NativeOperationError('SIP non-success response: 488', false, false, 488, false, true);
    const response = new Response();
    response.respond = async () => {
        f.caller.fence();
        throw new NativeOperationError('Native outcome unknown', true);
    };
    f.caller.emit('request', request('INVITE', sdp('10.0.0.1'), 43), response);
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.center.byes, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a fence on a detached leg has no effect on the call', async () => {
    const f = await handedOff();
    f.events.length = 0;
    // The carrier leg was replaced (detached): its fence must not end the call that now has another carrier.
    f.call.dialog = new Dialog('other', 'o-local', 'o-remote') as never;
    f.caller.fence();
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 0);
    // A destination detached by a return no longer speaks for the call either.
    const g = await handedOff();
    g.call.ownership = 'returning';
    g.center.emit('ended', 'bye');
    g.center.fence();
    await settle();
    assert.equal(g.registry.size, 1);
    assert.equal(g.caller.byes, 0);
});

test('a single-leg application call is unaffected by a fenced leg (the owner sees SIGNALING_UNKNOWN instead)', async () => {
    const f = await fixture();
    f.caller.fence();
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
});

test('a rollback re-INVITE answered with rejected audio ends the call after a failed transfer', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => (++calls === 1 ? sdp('10.0.0.1') : sdp('10.0.0.1', 0));
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.caller.reinvites.length, 2);
    assert.equal(f.registry.size, 0, 'the carrier is not left connected without audio');
    assert.equal(f.caller.byes, 1);
});

test('a rollback re-INVITE answered with rejected audio ends the call after a failed REFER return', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.reinviteHook = async () => sdp('10.0.0.1', 0);
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.caller.reinvites.length, 3, 'return attempt then rollback');
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
});

test('a Replaces whose authorizing destination was detached during the lookup is refused with 403 and scored', async () => {
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL: 'enforce' } as never));
    const observed: string[] = [];
    const original = firewall.observe.bind(firewall);
    firewall.observe = ((...args: Parameters<SipFirewall['observe']>) => {
        observed.push(args[2]);
        return original(...args);
    }) as SipFirewall['observe'];
    const f = await handedOff({ firewall });
    f.call.peerHost = 'localhost';
    f.call.peerAddress = undefined;
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '127.0.0.1') as never,
        response as never
    );
    await turn();
    // A REFER return detaches the destination (blind transfer) while its address is being resolved.
    f.call.ownership = 'returning';
    f.center.emit('ended', 'bye');
    await pending;
    assert.equal(response.status, 403);
    assert.equal(response.answered, undefined);
    assert.deepEqual(observed, ['unauthorized-replaces']);
    assert.equal(f.registry.get('caller'), f.call);
});

test('duplicate or comma-joined Replaces header fields are malformed: 400 and invalid-replaces before dialog lookup', async () => {
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL: 'enforce' } as never));
    const observed: string[] = [];
    const original = firewall.observe.bind(firewall);
    firewall.observe = ((...args: Parameters<SipFirewall['observe']>) => {
        observed.push(args[2]);
        return original(...args);
    }) as SipFirewall['observe'];
    const f = await handedOff({ firewall });
    f.call.peerAddresses = ['10.0.0.2'];
    const valid = 'center;to-tag=center-gateway-tag;from-tag=center-tag';
    const duplicate = { ...invite({ replaces: valid }, 'replacement', '10.0.0.2'), getAll: () => ['garbage', valid] };
    const joined = invite({ replaces: `${valid}, ${valid}` }, 'replacement', '10.0.0.2');
    for (const req of [duplicate, joined]) {
        const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
        await f.gateway.handleInvite(req as never, response as never);
        assert.equal(response.status, 400);
        assert.equal(response.answered, undefined);
    }
    assert.deepEqual(observed, ['invalid-replaces', 'invalid-replaces']);
    assert.equal(f.registry.get('caller'), f.call);
});

test('an app cancel that preceded the failed open result still gets the deadline CANCEL', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    const outbound = f.gateway.createOutbound({
        requestUri: 'sip:center@center.example',
        sdp: '',
        controlConnectionId: 'app',
        outboundAttemptId: 'attempt-3'
    } as never);
    const failed = assert.rejects(outbound, /deadline/);
    await turn();
    await f.gateway.cancelOutbound('attempt-3', 'app');
    assert.equal(f.cancelled(), 1);
    gate.reject(new NativeOperationError('Outbound setup deadline', true));
    await failed;
    await turn();
    assert.equal(f.cancelled(), 2);
});

const slowOwner = (f: Fixture) => {
    f.hub.request = (async (_id: string, method: string, params: unknown) => {
        f.requests.push({ method, params });
        await settle(5);
        return { action: 'answer', sdp: sdp('10.0.0.3', 41000) };
    }) as never;
};

test('a destination fenced by an UNKNOWN progress NOTIFY during an accepted return does not end the return', async () => {
    const f = await handedOff();
    f.events.length = 0;
    slowOwner(f);
    unknownNotify(f.center, '100 Trying');
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'application');
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0, 'a fenced destination is never commanded');
    assert.equal(sentEvents(f, 'sip.answered').length, 1);
    assert.equal(sentEvents(f, 'sip.terminated').length, 0);
});

test('a carrier fenced while the application is consulted ends the return once: one terminated, destination BYEd after the failure NOTIFY', async () => {
    const f = await handedOff();
    f.events.length = 0;
    slowOwner(f);
    f.center.emit('request', refer(), new Response());
    await turn();
    f.caller.fence();
    await settle(60);
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 0, 'a fenced carrier is never commanded');
    assert.equal(f.center.byes, 1);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
    const notify = f.log.findIndex(entry => entry === 'center:notify-503');
    assert.ok(notify >= 0 && notify < f.log.indexOf('center:bye'), 'final NOTIFY precedes the destination BYE');
});

test('a carrier fenced by the return re-INVITE itself is not committed', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.reinviteHook = async () => {
        f.caller.fence();
        return sdp('10.0.0.1');
    };
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(f.registry.size, 0);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(f.caller.byes, 0);
});

test('a leg fenced during a failed return that restores handed-off ends the call once', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.hub.request = (async () => {
        await settle(5);
        return { action: 'reject', status: 486 };
    }) as never;
    f.center.request = async () => {};
    f.center.emit('request', refer(), new Response());
    await turn();
    f.center.fence();
    await settle(60);
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a carrier fenced while the destination ACK is in flight is not committed by the transfer', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    const ack = f.center.ackAnswer.bind(f.center);
    f.center.ackAnswer = async (answer: string) => {
        await gate.promise;
        return ack(answer);
    };
    const transfer = f.gateway.transfer(f.params, 'app').catch(err => err);
    await settle(5);
    f.caller.fence();
    gate.resolve();
    const result = await transfer;
    await settle(20);
    assert.ok(result instanceof NativeOperationError && result.uncertain);
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 1);
    assert.equal(sentEvents(f, 'sip.transferred').length, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a transfer rollback answer with extra payload types keeps the call', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => (++calls === 1 ? sdp('10.0.0.1') : sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 0 8 101'));
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.call.ownership, 'application');
});

test('a transfer rollback answer on a new carrier port ends the call', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => (++calls === 1 ? sdp('10.0.0.1') : sdp('10.0.0.1', 40002));
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('a return rollback answer with extra payload types keeps the pair', async () => {
    const f = await handedOff();
    let calls = 0;
    // The first return re-INVITE is accepted by the carrier, but the owner disconnects before commit.
    f.caller.reinviteHook = async () => {
        calls++;
        if (calls === 1) {
            f.hub.isConnected = () => false;
            return sdp('10.0.0.1');
        }
        return sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 0 8 101');
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.caller.reinvites.length, 3, 'transfer, return attempt, rollback');
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.caller.byes, 0);
});

test('a return rollback answer on a new carrier port ends the call', async () => {
    const f = await handedOff();
    f.events.length = 0;
    let calls = 0;
    f.caller.reinviteHook = async () => {
        if (++calls === 1) {
            f.hub.isConnected = () => false;
            return sdp('10.0.0.1');
        }
        return sdp('10.0.0.1', 40002);
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.caller.reinvites.length, 3);
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
});

test('carrier hangup after the destination answer was observed sends no CANCEL; the destination is ACKed then BYEd', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayRecording(() => gate.promise);
    const transfer = f.gateway.transfer(f.params, 'app').catch(err => err);
    await settle(5);
    f.caller.emit('ended', 'bye');
    gate.resolve();
    await transfer;
    await settle(20);
    assert.equal(f.cancelled(), 0);
    assert.ok(f.log.indexOf('center:ack') >= 0 && f.log.indexOf('center:ack') < f.log.indexOf('center:bye'));
    assert.equal(f.center.byes, 1);
});

test('an app disconnect after the destination answer was observed sends no CANCEL', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayRecording(() => gate.promise);
    const transfer = f.gateway.transfer(f.params, 'app').catch(err => err);
    await settle(5);
    await f.gateway.terminateCallsForControlConnection('app');
    gate.resolve();
    await transfer;
    await settle(20);
    assert.equal(f.cancelled(), 0);
    assert.equal(f.center.byes, 1);
});

test('a transfer is refused while another registered call uses the same media endpoint', async () => {
    const f = await fixture();
    const other = new Dialog('other', 'other-tag', 'other-remote');
    await f.gateway.handleInvite(invite({}, 'other', '10.0.0.9') as never, new Response(other) as never);
    await turn();
    assert.equal(f.registry.size, 2, 'both calls were answered with the same local SDP');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /shared with another SIP call/);
    assert.equal(f.opened.length, 0);
    assert.equal(f.call.ownership, 'application');
});

test('a call the app answers with the source endpoint during a transfer is refused; the transfer proceeds', async () => {
    const f = await fixture();
    const other = new Dialog('other', 'other-tag', 'other-remote');
    const otherResponse = new Response(other);
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    const transfer = f.gateway.transfer(f.params, 'app');
    await settle(5);
    // The app answers call B with call A's endpoint while A's transfer is in progress.
    await f.gateway.handleInvite(invite({}, 'other', '10.0.0.9') as never, otherResponse as never);
    await turn();
    assert.equal(otherResponse.answered, undefined, 'the answer is never sent');
    assert.deepEqual(otherResponse.statuses, [488]);
    assert.equal(f.registry.get('other'), undefined);
    gate.resolve();
    const status = await transfer;
    assert.equal(status.state, 'completed');
    assert.equal(f.call.ownership, 'handed-off');
    // The reservation is released with the transfer: the endpoint is bindable again.
    const later = new Response(new Dialog('later', 'later-tag', 'later-remote'));
    await f.gateway.handleInvite(invite({}, 'later', '10.0.0.8') as never, later as never);
    assert.ok(later.answered);
});

test('an answer already in flight claims its endpoint: a transfer admitted meanwhile is refused instead of destroying it', async () => {
    const f = await fixture();
    const other = new Dialog('other', 'other-tag', 'other-remote');
    const otherResponse = new Response(other);
    const answerGate = Promise.withResolvers<void>();
    otherResponse.answerGate = answerGate.promise;
    const inbound = f.gateway.handleInvite(invite({}, 'other', '10.0.0.9') as never, otherResponse as never);
    await settle(5);
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /shared with another SIP call/);
    answerGate.resolve();
    await inbound;
    await settle(5);
    assert.ok(f.registry.get('other'), 'the in-flight answer is activated');
    assert.equal(other.byes, 0);
    assert.equal(f.call.ownership, 'application');
    assert.ok(!f.log.includes('delete-media'));
});

test('an application re-INVITE onto a reserved endpoint is refused with a conflict', async () => {
    const f = await fixture();
    const other = new Dialog('other', 'other-tag', 'other-remote');
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.4', 42000) }) as never;
    await f.gateway.handleInvite(invite({}, 'other', '10.0.0.9') as never, new Response(other) as never);
    await turn();
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    const transfer = f.gateway.transfer(f.params, 'app');
    await settle(5);
    await assert.rejects(f.gateway.reinvite('other', sdp('10.0.0.3')), SipOperationConflictError);
    assert.equal(other.reinvites.length, 0);
    gate.resolve();
    await transfer;
});

test('a Replaces return naming the carrier dialog commits even when the carrier fences during the consult', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'answer', sdp: sdp('10.0.0.3', 41000) } as never;
    };
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await turn();
    // The replaced carrier dialog fences (an UNKNOWN outcome) while the app is consulted; the replacement retires it anyway.
    f.caller.fence();
    f.events.length = 0;
    gate.resolve();
    await pending;
    await settle(20);
    assert.ok(response.answered, 'the replacement is answered');
    assert.deepEqual(
        f.registry.list().map(c => c.callId),
        ['replacement']
    );
    assert.equal(f.caller.byes, 0, 'the fenced carrier is never commanded (I5)');
    assert.equal(f.center.byes, 1, 'the destination leg is retired');
    assert.equal(replacement.byes, 0);
    assert.ok(
        !(f.events as any[]).some(e => e.data?.reason === 'return-peer-uncertain'),
        'the committed replacement is not terminated for the old legs'
    );
});

test('Refer-Sub: false is echoed in the 202 and suppresses NOTIFY; without it NOTIFYs are sent', async () => {
    const suppressed = await handedOff();
    const response = new Response();
    suppressed.center.emit('request', request('REFER', '', 42, { 'refer-to': '<sip:inbound@gateway.example>', 'refer-sub': 'false' }), response);
    await settle(60);
    assert.equal(response.status, 202);
    assert.equal(response.options?.headers?.['Refer-Sub'], 'false');
    assert.equal(suppressed.center.requests.filter(r => r.method === 'NOTIFY').length, 0);

    const normal = await handedOff();
    const plain = new Response();
    normal.center.emit('request', refer(), plain);
    await settle(60);
    assert.equal(plain.status, 202);
    assert.equal(plain.options?.headers?.['Refer-Sub'], undefined);
    assert.ok(normal.center.requests.filter(r => r.method === 'NOTIFY').length >= 1);
});

test('a Replaces whose quoted parameter contains a comma is not rejected as malformed', async () => {
    const f = await handedOff();
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    await f.gateway.handleInvite(invite({ replaces: 'abc@h;to-tag=1;from-tag=2;x="a,b"' }, 'replacement', '10.0.0.2') as never, response as never);
    assert.equal(response.status, 481, 'parsed, then no such dialog (not 400)');
    assert.equal(parseReplaces('abc@h;to-tag=1;from-tag=2;x="a,b"').toTag, '1');
});

test('rollback and endpoint helpers', () => {
    const prev = sdp('10.0.0.1');
    const restore = sdp('10.0.0.3');
    assertRollbackAnswer(sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 0 8 101'), prev, restore);
    assert.throws(() => assertRollbackAnswer(sdp('10.0.0.1', 0), prev, restore), /rejected/);
    assert.throws(() => assertRollbackAnswer(sdp('10.0.0.1', 40002), prev, restore), /address/);
    assert.equal(sharesMediaEndpoint(sdp('10.0.0.3'), sdp('10.0.0.3')), true);
    assert.equal(sharesMediaEndpoint(sdp('10.0.0.3'), sdp('10.0.0.3', 40002)), false);
});

test('a rollback answer that leaves the call on hold is rejected', () => {
    const prev = sdp('10.0.0.1');
    const restore = sdp('10.0.0.3');
    for (const direction of ['inactive', 'sendonly', 'recvonly'])
        assert.throws(() => assertRollbackAnswer(prev.replace('a=sendrecv', `a=${direction}`), prev, restore), /direction/, direction);
    // RFC 3264 6.1: a sendonly offer is answered recvonly.
    assertRollbackAnswer(prev.replace('a=sendrecv', 'a=recvonly'), prev, restore.replace('a=sendrecv', 'a=sendonly'));
    // A session-level direction applies to streams without their own.
    assert.throws(() => assertRollbackAnswer(prev.replace('a=sendrecv', '').replace('t=0 0', 't=0 0\r\na=inactive'), prev, restore), /direction/);
});

test('a rollback after a multi-stream offer whose rejected video stream was declined by the app is kept', () => {
    const carrierOffer =
        'v=0\r\no=- 1 1 IN IP4 1.1.1.1\r\ns=-\r\nc=IN IP4 1.1.1.1\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\nm=video 51372 RTP/AVP 31\r\n';
    const appAnswer = 'v=0\r\no=- 5 5 IN IP4 10.0.0.3\r\ns=-\r\nc=IN IP4 10.0.0.3\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0\r\nm=video 0 RTP/AVP 31\r\n';
    const destOffer =
        'v=0\r\no=- 9 9 IN IP4 10.0.0.2\r\ns=-\r\nc=IN IP4 10.0.0.2\r\nt=0 0\r\nm=audio 45000 RTP/AVP 0\r\nm=video 45002 RTP/AVP 31\r\n';
    const restore = relaySdp(appAnswer, relaySdp(destOffer, appAnswer));
    const answer = 'v=0\r\no=- 1 3 IN IP4 1.1.1.1\r\ns=-\r\nc=IN IP4 1.1.1.1\r\nt=0 0\r\nm=audio 49170 RTP/AVP 0\r\nm=video 0 RTP/AVP 31\r\n';
    assertRollbackAnswer(answer, carrierOffer, restore);
    assert.throws(() => assertRollbackAnswer(answer.replace('49170', '49172'), carrierOffer, restore), /address/);
    assert.throws(() => assertRollbackAnswer(answer.replace('m=audio 49170', 'm=audio 0'), carrierOffer, restore), /rejected/);
});

test('a forward answer may list extra formats but must keep one offered format', () => {
    const offer = sdp('10.0.0.2', 45000).replace('RTP/AVP 0 101', 'RTP/AVP 0');
    const answer = (formats: string, extra = '') => sdp('10.0.0.1').replace('RTP/AVP 0 101', `RTP/AVP ${formats}`) + extra;
    assertDirectMediaAnswer(offer, answer('0 9'));
    assertDirectMediaAnswer(offer, answer('9 0'));
    assert.throws(() => assertDirectMediaAnswer(offer, answer('9')), /Incompatible/);
    // Renumbered dynamic payload types match by encoding and clock.
    const dynamicOffer = offer.replace('RTP/AVP 0', 'RTP/AVP 96').replace('a=rtpmap:0 PCMU/8000', 'a=rtpmap:96 opus/48000');
    const dynamicAnswer = answer('97').replace('a=rtpmap:0 PCMU/8000', 'a=rtpmap:97 OPUS/48000');
    assertDirectMediaAnswer(dynamicOffer, dynamicAnswer);
    assert.throws(() => assertDirectMediaAnswer(dynamicOffer, dynamicAnswer.replace('OPUS/48000', 'speex/16000')), /Incompatible/);
});

test('a quoted Replaces parameter is never read as the early-only flag', () => {
    const quoted = parseReplaces('abc@h;to-tag=1;from-tag=2;x="note;early-only;end"');
    assert.equal(quoted.earlyOnly, false);
    assert.equal(quoted.toTag, '1');
    assert.equal(parseReplaces('abc@h;to-tag=1;from-tag=2;early-only').earlyOnly, true);
    assert.equal(parseReplaces('abc@h;to-tag=1;EARLY-ONLY;from-tag=2').earlyOnly, true);
    assert.equal(parseReplaces('abc@h;to-tag=1;from-tag=2;x="a\\";early-only"').earlyOnly, false);
    assert.throws(() => parseReplaces('abc@h;to-tag=1;from-tag=2;x="open'), /quoted|Invalid/);
});

async function sharedEndpointFixture() {
    const f = await fixture();
    const other = new Dialog('other', 'other-tag', 'other-remote');
    // B answered with the same endpoint as A (10.0.0.3:40000): currently shared.
    await f.gateway.handleInvite(invite({}, 'other', '10.0.0.9') as never, new Response(other) as never);
    await turn();
    assert.equal(f.registry.size, 2);
    return { f, other };
}

test('a pending app re-INVITE away from a shared endpoint does not hide the committed one: the transfer is refused', async () => {
    const { f, other } = await sharedEndpointFixture();
    const gate = Promise.withResolvers<void>();
    other.reinviteHook = async () => {
        await gate.promise;
        throw new NativeOperationError('SIP non-success response: 488', false, false, 488, false, true);
    };
    const reinvite = f.gateway.reinvite('other', sdp('10.0.0.4', 42000)).catch(error => error);
    await turn();
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /shared with another SIP call/);
    gate.resolve();
    await reinvite;
    assert.ok(!f.log.includes('delete-media'));
    assert.equal(f.registry.size, 2);
    assert.match(f.registry.get('other')!.localSdp!, /m=audio 40000 /);
});

test('a remote re-INVITE answer in flight claims its endpoint before the 200 is written', async () => {
    const f = await fixture();
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.4', 42000) }) as never;
    const other = new Dialog('other', 'other-tag', 'other-remote');
    await f.gateway.handleInvite(invite({}, 'other', '10.0.0.9') as never, new Response(other) as never);
    await turn();
    // B's carrier re-INVITEs and the application answers with A's endpoint; the 200 is slow to be written.
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.3') }) as never;
    const gate = Promise.withResolvers<void>();
    const res = new Response(other);
    const respond = res.respond.bind(res);
    res.respond = async (status: number, options?: { body?: string; headers?: Record<string, string> }) => {
        await gate.promise;
        return respond(status, options);
    };
    other.emit('request', request('INVITE', sdp('10.0.0.9')), res);
    await settle(5);
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /shared with another SIP call/);
    gate.resolve();
    await settle(5);
    assert.ok(!f.log.includes('delete-media'));
    assert.match(f.registry.get('other')!.localSdp!, /m=audio 40000 /);
});

test('a carrier result with an ended snapshot before the BYE event fails the transfer cleanly', async () => {
    const f = await fixture();
    f.caller.reinviteHook = async () => {
        f.caller.isEnded = true;
        return sdp('10.0.0.1');
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    await settle();
    assert.equal(f.events.filter(e => (e as { event: string }).event === 'sip.transferred').length, 0);
    assert.ok(!f.log.includes('delete-media'));
    assert.equal(f.registry.size, 0);
    assert.equal(f.center.byes, 1);
    assert.ok(f.log.indexOf('center:ack') < f.log.indexOf('center:bye'));
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    // The late terminal event finds nothing to end.
    f.caller.emit('ended', 'bye');
    await settle();
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
});

test('a REFER return whose carrier ended on the re-INVITE result reports neither success NOTIFY nor answered', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.reinviteHook = async () => {
        f.caller.isEnded = true;
        return sdp('10.0.0.1');
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    const notifies = f.center.requests.filter(r => r.method === 'NOTIFY').map(r => r.body ?? '');
    assert.ok(!notifies.some(body => body.includes('200 OK')));
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
    assert.equal(f.registry.size, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(f.center.byes, 1);
});

test('a carrier fenced while the failed transfer rejects the destination offer is removed, not restored to the application', async () => {
    const f = await fixture();
    f.failRecording();
    const ack = f.center.ackAnswer.bind(f.center);
    f.center.ackAnswer = async (answer: string) => {
        f.caller.fence();
        await ack(answer);
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(sentEvents(f, 'sip.terminated').length, 1);
    assert.equal(f.caller.byes, 0, 'a fenced carrier is never commanded');
    assert.equal(f.center.byes, 1);
});

test('a transfer rollback answer on a codec the application endpoint does not speak ends the call', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => (++calls === 1 ? sdp('10.0.0.1') : sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 8'));
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('a return rollback answer on a codec the destination is not sending ends the pair', async () => {
    const f = await handedOff();
    f.events.length = 0;
    let calls = 0;
    f.caller.reinviteHook = async () => {
        if (++calls === 1) {
            f.hub.isConnected = () => false;
            return sdp('10.0.0.1');
        }
        return sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 8');
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('a rollback after an offerless inbound INVITE keeps the call: the carrier SDP is taken from the native dialog', async () => {
    const f = await fixture();
    // The registry holds the empty INVITE body; the carrier's SDP lives only in the native snapshot (learned from the ACK).
    f.call.remoteSdp = '';
    f.center.ackFailure = new Error('ACK send rejected');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.call.ownership, 'application');
    assert.match(f.call.remoteSdp!, /c=IN IP4 10\.0\.0\.1/);
});

test('direct-media answers need a real voice codec in common, not telephone-event or comfort noise', () => {
    const wrap = (body: string) => 'v=0\r\no=- 1 1 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\n' + body;
    const dtmf = 'a=rtpmap:101 telephone-event/8000\r\n';
    assert.throws(
        () =>
            assertDirectMediaAnswer(
                wrap(`m=audio 5000 RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\n${dtmf}`),
                wrap(`m=audio 6000 RTP/AVP 18 101\r\na=rtpmap:18 G729/8000\r\n${dtmf}`)
            ),
        /Incompatible/
    );
    assert.throws(() => assertDirectMediaAnswer(wrap('m=audio 5000 RTP/AVP 0 13\r\n'), wrap('m=audio 6000 RTP/AVP 18 13\r\n')), /Incompatible/);
    assertDirectMediaAnswer(
        wrap(`m=audio 5000 RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\n${dtmf}`),
        wrap(`m=audio 6000 RTP/AVP 0 101 8\r\na=rtpmap:0 PCMU/8000\r\n${dtmf}`)
    );
});

test('Replaces parsing: a quote in the Call-ID, generic-param values and a trailing semicolon', () => {
    assert.equal(parseReplaces('abc"def@host;to-tag=a;from-tag=b').callId, 'abc"def@host');
    assert.throws(() => parseReplaces('abc@host;to-tag=a;from-tag=b;x=a,b'), /Invalid Replaces parameter/);
    assert.equal(parseReplaces('abc@host;to-tag=a;from-tag=b;x="a,b"').toTag, 'a');
    // gen-value = token / host / quoted-string: a host carries no port (RFC 3261 25.1).
    assert.throws(() => parseReplaces('abc@host;to-tag=a;from-tag=b;x=host.example:5060'), /Invalid Replaces parameter/);
    assert.throws(() => parseReplaces('abc@host;to-tag=a;from-tag=b;x=[2001:db8::1]:5060'), /Invalid Replaces parameter/);
    assert.throws(() => parseReplaces('abc@host;to-tag=a;from-tag=b;x=a]b['), /Invalid Replaces parameter/);
    assert.equal(parseReplaces('abc@host;to-tag=a;from-tag=b;x=host.example').toTag, 'a');
    assert.equal(parseReplaces('abc@host;to-tag=a;from-tag=b;x=[2001:db8::1]').toTag, 'a');
    assert.equal(parseReplaces('abc@host;to-tag=a;from-tag=b;x="host.example:5060"').toTag, 'a');
    // SEMI = SWS ";" SWS: whitespace before the first semicolon is legal.
    assert.equal(parseReplaces('abc@host ;to-tag=a;from-tag=b').callId, 'abc@host');
    assert.equal(parseReplaces('abc@host;to-tag=a;from-tag=b;').fromTag, 'b');
    assert.throws(() => parseReplaces('abc@host;to-tag=a;from-tag=b;;x=1'), /Invalid Replaces parameter/);
});

const media = (ip: string, port: number, pts: string, maps: string[], addrType = 'IP4') =>
    [
        'v=0',
        `o=- 100 1 IN ${addrType} ${ip}`,
        's=-',
        `c=IN ${addrType} ${ip}`,
        't=0 0',
        `m=audio ${port} RTP/AVP ${pts}`,
        ...maps,
        'a=sendrecv',
        ''
    ].join('\r\n');
const PCMU = 'a=rtpmap:0 PCMU/8000';
const PCMA = 'a=rtpmap:8 PCMA/8000';
const TELEPHONE_EVENT = 'a=rtpmap:101 telephone-event/8000';

test('endpoint sharing canonicalizes IPv6 spelling, brackets, mapped IPv4 and numeric ports', () => {
    const v6 = (ip: string, port: number | string) =>
        media(ip, Number(port), '0', [PCMU], 'IP6').replace(`m=audio ${Number(port)}`, `m=audio ${port}`);
    assert.equal(sharesMediaEndpoint(v6('2001:db8::10', 40000), v6('2001:0db8:0:0:0:0:0:10', 40000)), true);
    assert.equal(sharesMediaEndpoint(v6('2001:db8::10', 40000), v6('2001:0DB8::0010', '040000')), true);
    assert.equal(sharesMediaEndpoint(v6('2001:db8::10', 40000), v6('2001:db8::11', 40000)), false);
    assert.equal(sharesMediaEndpoint(v6('2001:db8::10', 40000), v6('2001:db8::10', 40002)), false);
    assert.equal(sharesMediaEndpoint(v6('::ffff:10.0.0.3', 40000), media('10.0.0.3', 40000, '0', [PCMU])), true);
});

test('a rollback answer must keep the voice codec the untouched leg selected', () => {
    const previousSdp = media('10.0.0.3', 40000, '0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]);
    const previousRemoteSdp = media('10.0.0.1', 30000, '0 101', [PCMU, TELEPHONE_EVENT]);
    const answer = (pts: string, maps: string[]) => media('10.0.0.1', 30000, pts, maps);
    // Transfer rollback: the untouched leg is the application endpoint, which negotiated PCMU.
    assert.throws(() => assertRollbackAnswer(answer('8 101', [PCMA, TELEPHONE_EVENT]), previousRemoteSdp, previousSdp, previousRemoteSdp), /codec/);
    assertRollbackAnswer(answer('0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]), previousRemoteSdp, previousSdp, previousRemoteSdp);
    assertRollbackAnswer(answer('8 0', [PCMA, PCMU]), previousRemoteSdp, previousSdp, previousRemoteSdp);
    // REFER rollback: the destination holds PCMU+PCMA but sends the first one (PCMU) that the carrier also had.
    const destination = media('10.0.0.2', 45000, '0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]);
    assert.throws(() => assertRollbackAnswer(answer('8', [PCMA]), previousRemoteSdp, previousSdp, destination), /codec/);
    assertRollbackAnswer(answer('0 8', [PCMU, PCMA]), previousRemoteSdp, previousSdp, destination);
    // Static payload types match without an rtpmap.
    assertRollbackAnswer(answer('0', []), previousRemoteSdp, previousSdp, previousRemoteSdp);
});

test('a direct-media answer is classified by the offer rtpmap when the answer leaves a payload type unmapped', () => {
    const offer = media('10.0.0.5', 5000, '0 101', [PCMU, TELEPHONE_EVENT]);
    assert.throws(() => assertDirectMediaAnswer(offer, media('10.0.0.6', 6000, '101', [])), /Incompatible/);
    assertDirectMediaAnswer(offer, media('10.0.0.6', 6000, '0', []));
    assertDirectMediaAnswer(offer, media('10.0.0.6', 6000, '0 101', [PCMU.toLowerCase(), 'a=rtpmap:101 TELEPHONE-EVENT/8000']));
});

test('a transfer rollback whose carrier answers only a codec the application does not send ends the call', async () => {
    const f = await fixture();
    f.caller.remoteSdp = media('10.0.0.1', 30000, '0 101', [PCMU, TELEPHONE_EVENT]);
    f.call.localSdp = media('10.0.0.3', 40000, '0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]);
    f.call.remoteSdp = f.caller.remoteSdp;
    let reinvites = 0;
    // The destination's audio is rejected, so the carrier is restored, and answers PCMA only.
    f.caller.reinviteHook = async () =>
        ++reinvites === 1 ? media('10.0.0.1', 0, '0 101', [PCMU, TELEPHONE_EVENT]) : media('10.0.0.1', 30000, '8 101', [PCMA, TELEPHONE_EVENT]);
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /audio was rejected/);
    await settle(30);
    assert.equal(f.registry.get('caller'), undefined, 'the unrepairable rollback ended the call');
    assert.ok(f.caller.byes >= 1);
});

test('a transfer of a returned call is not blocked by the return claim while the old legs are retired', async () => {
    const f = await handedOff();
    f.call.peerHost = '10.0.0.2';
    const byeGate = Promise.withResolvers<void>();
    const origBye = f.caller.bye.bind(f.caller);
    f.caller.bye = async () => {
        await byeGate.promise;
        return origBye();
    };
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.7', 47000) }) as never;
    const replacement = new Dialog('replacement', 'rep-local', 'rep-remote');
    const returning = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        new Response(replacement) as never
    );
    await settle(5);
    const returned = f.registry.get('replacement');
    assert.ok(returned, 'return activated');
    assert.equal(returned!.ownership, 'application');
    const result = await f.gateway.transfer({ ...f.params, sessionId: 'replacement', transferId: 'transfer-2' }, 'app').then(
        () => 'ok',
        (err: Error) => err.message
    );
    assert.equal(result, 'ok');
    byeGate.resolve();
    await returning;
});

test('a Replaces return naming the destination is refused with 603 when the carrier already ended', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    f.hub.request = async () => {
        await gate.promise;
        return { action: 'answer', sdp: sdp('10.0.0.3') } as never;
    };
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await turn();
    f.caller.isEnded = true; // a command result marked it ended; the terminal event is still pending
    gate.resolve();
    await pending;
    await turn();
    assert.deepEqual(response.statuses, [603]);
    assert.equal(response.answered, undefined);
});

test('a Replaces return naming the destination tears down the replacement when the carrier ends during the answer', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    const gate = Promise.withResolvers<void>();
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    response.answerGate = gate.promise;
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    await settle(5);
    f.caller.isEnded = true;
    gate.resolve();
    await pending;
    await turn();
    assert.equal(f.registry.get('replacement'), undefined);
    assert.equal(replacement.byes, 1);
});

test('a fenced carrier does not block a Replaces return naming the destination', async () => {
    const f = await handedOff();
    f.call.peerAddress = undefined;
    f.call.peerAddresses = ['10.0.0.2'];
    f.caller.fence();
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        new Response(replacement) as never
    );
    await settle(5);
    assert.ok(f.registry.get('replacement'));
    assert.equal(replacement.byes, 0);
});

test('an application-owned Replaces whose old dialog ended during the answer BYEs the replacement', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    response.answerGate = gate.promise;
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.8', 48000) }) as never;
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(5);
    f.caller.isEnded = true;
    gate.resolve();
    await pending;
    await settle(5);
    assert.equal(replacement.byes, 1);
    assert.equal(f.registry.get('caller')?.dialog, f.caller, 'the ended dialog was not swapped out');
});

test('a failed application-owned Replaces whose restored media moved renegotiates the original peer', async () => {
    const f = await fixture();
    const answers = [sdp('10.0.0.8', 48000), sdp('10.0.0.9', 49000)];
    f.hub.request = async () => ({ action: 'answer', sdp: answers.shift()! }) as never;
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(10);
    assert.equal(f.caller.reinvites.length, 1);
    assert.match(f.caller.reinvites[0], /c=IN IP4 10\.0\.0\.9/);
    assert.match(f.registry.get('caller')!.localSdp!, /10\.0\.0\.9/);
    assert.equal(f.caller.byes, 0);
});

test('a failed application-owned Replaces ends the call when the original peer refuses the restored media', async () => {
    const f = await fixture();
    const answers = [sdp('10.0.0.8', 48000), sdp('10.0.0.9', 49000)];
    f.hub.request = async () => ({ action: 'answer', sdp: answers.shift()! }) as never;
    f.caller.reinviteFailure = new Error('488');
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(30);
    assert.equal(f.registry.get('caller'), undefined);
});
