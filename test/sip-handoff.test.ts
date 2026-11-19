import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CallRegistry } from '../src/call-registry';
import { InvalidHttpActionError } from '../src/http-contract';
import { GatewayLifecycle } from '../src/gateway-lifecycle';
import { controlErrorForCommand } from '../src/session-commands';
import { SipGateway, SipOperationConflictError } from '../src/sip-gateway';
import { isSipTransferStatus } from '../src/sip-handoff-contract';
import {
    assertDirectMediaAnswer,
    assertRollbackAnswer,
    parseReferTarget,
    parseReplaces,
    preservesMediaParameters,
    rejectSdpOffer,
    relaySdp,
    sharesMediaEndpoint,
    usesHostnameMedia
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
    /** True for a dialog the gateway opened (UAC), as NativeDialog.isOutbound. */
    isOutbound = false;
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
    /** False models a 2xx whose body is not SDP (sipbridge already ACKed it): no late offer, no ACK owed. */
    offerlessIsSdp = true;
    async reinviteOffer() {
        const offer = await this.reinvite('');
        return this.offerlessIsSdp ? { sdp: offer, offered: true } : { sdp: '', offered: false };
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
    const body = method === 'INVITE' && !('nobody' in headers) ? sdp(address) : '';
    const all: Record<string, string> = {
        'call-id': callId,
        from: '<sip:18055550123@carrier.example>',
        ...(body && { 'content-type': 'application/sdp' }),
        ...headers
    };
    return {
        method,
        uri: 'sip:inbound@gateway.example',
        body,
        callId,
        cseq,
        source: { ip: address, port: 5060, transport: 'udp' },
        headers: all,
        get: (name: string) => all[name.toLowerCase()]
    };
}

function request(method: string, body = '', cseq = 42, headers: Record<string, string> = {}) {
    const all: Record<string, string> = { cseq: `${cseq} ${method}`, ...(body ? { 'content-type': 'application/sdp' } : {}), ...headers };
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
        glareDelayMs?: (originated: boolean) => number;
    } = {}
) {
    const registry = new CallRegistry();
    const log: string[] = [];
    const caller = new Dialog('caller', 'gateway-tag', 'caller-tag');
    caller.name = 'caller';
    caller.log = log;
    const center = new Dialog('center', 'center-gateway-tag', 'center-tag');
    center.name = 'center';
    center.isOutbound = true;
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
        findRoute: (): { connectionId: string; route: { url: string } } | undefined => ({ connectionId: 'app', route: { url: 'control://app' } }),
        isConnected: (_id?: string) => true,
        holdsRoute(id: string, destination?: unknown) {
            return hub.isConnected(id) && hub.findRoute()?.connectionId === id;
        },
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
            restoreRetryDelaysMs: [1, 2, 3],
            glareDelayMs: options.glareDelayMs ?? (() => 1),
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
        healRecording: () => {
            prepareFailure = undefined;
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

test('an offerless or non-SDP Replaces INVITE is rejected before the app is consulted and keeps the pair intact', async () => {
    const f = await handedOff();
    f.call.peerHost = '10.0.0.2';
    const replaces = 'center;to-tag=center-gateway-tag;from-tag=center-tag';
    const requestsBefore = f.requests.length;
    const offerless = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    await f.gateway.handleInvite(invite({ replaces, nobody: '1' }, 'replacement', '10.0.0.2') as never, offerless as never);
    assert.equal(offerless.status, 488);
    const wrongType = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    const nonSdp = { ...invite({ replaces, 'content-type': 'text/plain' }, 'replacement', '10.0.0.2'), body: 'hello' };
    await f.gateway.handleInvite(nonSdp as never, wrongType as never);
    assert.equal(wrongType.status, 415);
    assert.equal(offerless.answered, undefined);
    assert.equal(wrongType.answered, undefined);
    assert.equal(f.requests.length, requestsBefore, 'the application was not consulted');
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.registry.get('caller'), f.call);
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0);
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
    assert.ok(returned.returnAttemptId);
    const answeredEvent = f.events.findLast(e => (e as { event?: string }).event === 'sip.answered') as { data: { returnAttemptId?: string } };
    assert.equal(answeredEvent.data.returnAttemptId, returned.returnAttemptId);
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

test('an offerless or non-SDP Replaces of an application-owned call is rejected before the owner is consulted', async () => {
    const f = await fixture();
    const replaces = 'caller;to-tag=gateway-tag;from-tag=caller-tag';
    const reinvitesBefore = f.requests.filter(r => r.method === 'sip.reinvite').length;
    const offerless = new Response(new Dialog('replacement', 'rep-local', 'rep-remote'));
    await f.gateway.handleInvite(invite({ replaces, nobody: '1' }, 'replacement') as never, offerless as never);
    assert.equal(offerless.status, 488);
    const wrongType = new Response(new Dialog('replacement', 'rep-local', 'rep-remote'));
    const nonSdp = { ...invite({ replaces, 'content-type': 'text/plain' }, 'replacement'), body: 'hello' };
    await f.gateway.handleInvite(nonSdp as never, wrongType as never);
    assert.equal(wrongType.status, 415);
    assert.equal(offerless.answered, undefined);
    assert.equal(wrongType.answered, undefined);
    assert.equal(f.requests.filter(r => r.method === 'sip.reinvite').length, reinvitesBefore);
    assert.equal(f.caller.byes, 0);
    assert.equal(f.registry.get('caller'), f.call);
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
    // The destination referred, so the call's end is not held behind its final NOTIFY (R2): the NOTIFY is no longer ordered before the BYE.
    assert.ok(f.log.includes('center:notify-100'));
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
    // The call's own end is followed by the attempt's correlated outcome (R1).
    const terminated = sentEvents(f, 'sip.terminated') as { data: { reason: string; returnAttemptId?: string } }[];
    assert.deepEqual(
        terminated.map(event => event.data.reason),
        ['return-carrier-uncertain', 'return-aborted']
    );
    assert.equal(terminated[1].data.returnAttemptId, f.requests.findLast(r => r.method === 'sip.invite')!.params.returnAttemptId);
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

test('a carrier that hangs up while the REFER 202 is pending is never offered the return: no invite after bye', async () => {
    const f = await handedOff();
    f.events.length = 0;
    const invitesBefore = f.requests.filter(r => r.method === 'sip.invite').length;
    const gate = Promise.withResolvers<void>();
    const response = new Response();
    const respond = response.respond.bind(response);
    response.respond = async (status: number, options?: never) => {
        await gate.promise;
        return respond(status, options);
    };
    f.center.emit('request', refer(), response);
    await turn();
    f.caller.emit('ended', 'bye');
    await turn();
    assert.equal(f.registry.size, 0);
    gate.resolve();
    await settle();
    assert.equal(f.requests.filter(r => r.method === 'sip.invite').length, invitesBefore, 'the return was never offered');
    assert.equal(sentEvents(f, 'sip.bye').length, 1);
    assert.equal(sentEvents(f, 'sip.terminated').length, 0);
    assert.equal(f.caller.reinvites.length, 1, 'no return re-INVITE');
    assert.equal(f.center.byes, 1, 'the end handler BYEd the destination once');
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

test('a Replaces with a quoted to-tag is malformed: 400 and invalid-replaces', async () => {
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL: 'enforce' } as never));
    const observed: string[] = [];
    const original = firewall.observe.bind(firewall);
    firewall.observe = ((...args: Parameters<SipFirewall['observe']>) => {
        observed.push(args[2]);
        return original(...args);
    }) as SipFirewall['observe'];
    const f = await handedOff({ firewall });
    f.call.peerAddresses = ['10.0.0.2'];
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag="center-gateway-tag";from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    assert.equal(response.status, 400);
    assert.deepEqual(observed, ['invalid-replaces']);
    assert.throws(() => parseReplaces('abc@h;to-tag=1;from-tag="2"'), /tag/);
    assert.equal(f.registry.get('caller'), f.call);
});

test('rollback keeps the security mode and every previously active stream', () => {
    const two = (videoPort: number, extra: string[] = [], videoExtra: string[] = []) =>
        [
            'v=0',
            'o=- 100 1 IN IP4 10.0.0.1',
            's=-',
            'c=IN IP4 10.0.0.1',
            't=0 0',
            'm=audio 30000 RTP/AVP 0',
            'a=rtpmap:0 PCMU/8000',
            'a=sendrecv',
            ...extra,
            `m=video ${videoPort} RTP/AVP 96`,
            'a=rtpmap:96 VP8/90000',
            'a=sendrecv',
            ...videoExtra,
            ''
        ].join('\r\n');
    const restore = two(40002).replaceAll('10.0.0.1', '10.0.0.3');
    // audio + video previously active: the answer cannot drop video.
    assert.throws(() => assertRollbackAnswer(two(0), two(30002), restore), /active stream/);
    assertRollbackAnswer(two(30002), two(30002), restore);
    // video previously rejected: staying at 0 is fine.
    assertRollbackAnswer(two(0), two(0), restore);
    // plain RTP before: a rollback answer adding crypto or a fingerprint switches the security mode.
    const crypto = 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abcd';
    assert.throws(() => assertRollbackAnswer(two(0, [crypto]), two(0), restore), /plain stream/);
    assert.throws(() => assertRollbackAnswer(two(0, ['a=fingerprint:sha-256 AA:BB']), two(0), restore), /fingerprint/);
    assert.throws(() => assertRollbackAnswer(two(0), two(0, ['a=fingerprint:sha-256 AA:BB']), restore), /fingerprint/);
    // The restore offer carries crypto too: keys already negotiated stay valid.
    const restoreCrypto = two(40002, ['a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:zzzz']).replaceAll('10.0.0.1', '10.0.0.3');
    assertRollbackAnswer(two(0, [crypto]), two(0, [crypto]), restoreCrypto);
    // R2: the DTLS fingerprint value (case-insensitive hash and value) and the role must be unchanged.
    const fp = (value: string) => `a=fingerprint:sha-256 ${value}`;
    assertRollbackAnswer(two(0, [fp('AA:BB')]), two(0, [fp('aa:bb').replace('sha-256', 'SHA-256')]), restore);
    assert.throws(() => assertRollbackAnswer(two(0, [fp('CC:DD')]), two(0, [fp('AA:BB')]), restore), /fingerprint/);
    assert.throws(() => assertRollbackAnswer(two(0, [fp('AA:BB'), fp('CC:DD')]), two(0, [fp('AA:BB')]), restore), /fingerprint/);
    assert.throws(
        () => assertRollbackAnswer(two(0, [fp('AA:BB'), 'a=setup:active']), two(0, [fp('AA:BB'), 'a=setup:passive']), restore),
        /fingerprint/
    );
    assertRollbackAnswer(two(0, [fp('AA:BB'), 'a=setup:active']), two(0, [fp('AA:BB'), 'a=setup:actpass']), restore);
});

test('the SDES check follows the restore offer: opportunistic SRTP answered plain stays valid (R1)', () => {
    const sdp = (extra: string[] = [], proto = 'RTP/AVP') => media('10.0.0.1', 30000, '0', [PCMU, ...extra]).replace('RTP/AVP', proto);
    const key = (value: string) => `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${value}`;
    const plainRestore = media('10.0.0.3', 40000, '0', [PCMU]);
    const cryptoRestore = media('10.0.0.3', 40000, '0', [PCMU, key('RRRR')]);
    // The carrier offered opportunistic SRTP, the application answered plain: a plain restore answer is kept.
    assertRollbackAnswer(sdp(), sdp([key('AAAA')]), plainRestore);
    // The offer carries no crypto: an answer with crypto is invalid whatever the carrier had.
    assert.throws(() => assertRollbackAnswer(sdp([key('AAAA')]), sdp([key('AAAA')]), plainRestore), /plain stream/);
    // Both sides have crypto: the answer needs crypto, with keys the carrier already had.
    assertRollbackAnswer(sdp([key('AAAA')]), sdp([key('AAAA')]), cryptoRestore);
    assert.throws(() => assertRollbackAnswer(sdp(), sdp([key('AAAA')]), cryptoRestore), /SDES/);
    assert.throws(() => assertRollbackAnswer(sdp([key('BBBB')]), sdp([key('AAAA')]), cryptoRestore), /SDES/);
    // The offer has crypto but the carrier had none: the answer must stay plain.
    assertRollbackAnswer(sdp(), sdp(), cryptoRestore);
    assert.throws(() => assertRollbackAnswer(sdp([key('BBBB')]), sdp(), cryptoRestore), /plain stream/);
});

test('preservesMediaParameters treats a remapped dynamic payload type as a change', () => {
    const opus = (pt: string) => media('10.0.0.3', 40000, `${pt} 101`, [`a=rtpmap:${pt} opus/48000/2`, 'a=rtpmap:101 telephone-event/48000']);
    const carrier = media('10.0.0.1', 30000, '111 101', ['a=rtpmap:111 opus/48000/2', 'a=rtpmap:101 telephone-event/48000']);
    assert.equal(preservesMediaParameters(opus('111'), opus('111'), carrier), true);
    assert.equal(preservesMediaParameters(opus('111'), opus('96'), carrier), false);
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
    // The call's own end precedes the attempt's outcome, which carries the attempt id of the return invite.
    const terminated = sentEvents(f, 'sip.terminated') as { data: { reason: string; returnAttemptId?: string } }[];
    assert.deepEqual(
        terminated.map(event => event.data.reason),
        ['return-carrier-uncertain', 'return-aborted']
    );
    assert.equal(terminated[1].data.returnAttemptId, f.requests.findLast(r => r.method === 'sip.invite')!.params.returnAttemptId);
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
    const terminated = sentEvents(f, 'sip.terminated') as { data: { reason: string; returnAttemptId?: string } }[];
    assert.deepEqual(
        terminated.map(event => event.data.reason),
        ['return-carrier-uncertain', 'return-aborted']
    );
    assert.equal(terminated[1].data.returnAttemptId, f.requests.findLast(r => r.method === 'sip.invite')!.params.returnAttemptId);
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

test('a transfer rollback answer with extra non-voice payload types keeps the call', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => (++calls === 1 ? sdp('10.0.0.1') : sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 0 101 13'));
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

test('a return rollback answer with extra non-voice payload types keeps the pair', async () => {
    const f = await handedOff();
    let calls = 0;
    // The first return re-INVITE is accepted by the carrier, but the owner disconnects before commit.
    f.caller.reinviteHook = async () => {
        calls++;
        if (calls === 1) {
            f.hub.isConnected = () => false;
            return sdp('10.0.0.1');
        }
        return sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 0 101 13');
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
    assertRollbackAnswer(sdp('10.0.0.1').replace('RTP/AVP 0 101', 'RTP/AVP 0 101 13'), prev, restore);
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
    const dir = (sdpText: string, direction: string) => sdpText.replace('a=sendrecv', `a=${direction}`);
    // Effective direction = previous direction limited by the restore offer's answer direction (RFC 3264 6.1).
    // Carrier offered sendrecv, local answered sendonly: restore offer sendonly, carrier answers recvonly -> kept.
    assertRollbackAnswer(dir(prev, 'recvonly'), dir(prev, 'recvonly'), dir(restore, 'sendonly'));
    // Carrier answered inactive previously, restore offer sendrecv: answer inactive kept, answer sendrecv rejected.
    assertRollbackAnswer(dir(prev, 'inactive'), dir(prev, 'inactive'), restore);
    assert.throws(() => assertRollbackAnswer(prev, dir(prev, 'inactive'), restore), /direction/);
    // Carrier offered sendrecv, destination answered recvonly: restore offer recvonly, carrier answers sendonly -> kept.
    assertRollbackAnswer(dir(prev, 'sendonly'), prev, dir(restore, 'recvonly'));
    // Previously sendrecv, restore offer sendonly: the effective direction is recvonly. A non-compliant sendrecv answer
    // keeps that flow (its effective direction under the offer is recvonly) and is kept; sendonly is rejected.
    assertRollbackAnswer(prev, prev, dir(restore, 'sendonly'));
    assert.throws(() => assertRollbackAnswer(dir(prev, 'sendonly'), prev, dir(restore, 'sendonly')), /direction/);
    assertRollbackAnswer(dir(prev, 'recvonly'), prev, dir(restore, 'sendonly'));
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
    // The end path reports the call's end once; the owner that answered the return invite additionally hears that the
    // return attempt was aborted, so it can release media prepared for it.
    assert.deepEqual(
        sentEvents(f, 'sip.terminated')
            .map(e => (e as { data?: { reason?: string } }).data?.reason)
            .filter(reason => reason === 'return-aborted'),
        ['return-aborted']
    );
    assert.equal(sentEvents(f, 'sip.terminated').length, 2);
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

test('a rollback answer must keep exactly the voice codecs the untouched leg negotiated', () => {
    const previousSdp = media('10.0.0.3', 40000, '0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]);
    const previousRemoteSdp = media('10.0.0.1', 30000, '0 101', [PCMU, TELEPHONE_EVENT]);
    const answer = (pts: string, maps: string[]) => media('10.0.0.1', 30000, pts, maps);
    // Transfer rollback: the untouched leg is the application endpoint, which negotiated {PCMU} with the carrier.
    assert.throws(() => assertRollbackAnswer(answer('8 101', [PCMA, TELEPHONE_EVENT]), previousRemoteSdp, previousSdp), /voice codecs/);
    // An extra voice codec is not negotiated either (the untouched leg decodes only what it negotiated).
    assert.throws(() => assertRollbackAnswer(answer('0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]), previousRemoteSdp, previousSdp), /voice codecs/);
    assert.throws(() => assertRollbackAnswer(answer('8 0', [PCMA, PCMU]), previousRemoteSdp, previousSdp), /voice codecs/);
    // Non-voice formats may come and go; order does not matter.
    assertRollbackAnswer(answer('0 101', [PCMU, TELEPHONE_EVENT]), previousRemoteSdp, previousSdp);
    assertRollbackAnswer(answer('0', [PCMU]), previousRemoteSdp, previousSdp);
    assertRollbackAnswer(answer('101 0 13', [TELEPHONE_EVENT, PCMU]), previousRemoteSdp, previousSdp);
    // Static payload types match without an rtpmap.
    assertRollbackAnswer(answer('0', []), previousRemoteSdp, previousSdp);
    // REFER rollback: the destination and the carrier negotiated {PCMU, PCMA}; the carrier may reorder but not drop PCMA.
    const carrierBefore = media('10.0.0.1', 30000, '0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]);
    const destination = media('10.0.0.2', 45000, '0 8 101', [PCMU, PCMA, TELEPHONE_EVENT]);
    assert.throws(() => assertRollbackAnswer(answer('0 101', [PCMU]), carrierBefore, previousSdp), /voice codecs/);
    assertRollbackAnswer(answer('8 0', [PCMA, PCMU]), carrierBefore, previousSdp);
    // Codex 3: negotiated `0 8`, the destination may send PCMA, the restored answer accepts PCMU only.
    assert.throws(() => assertRollbackAnswer(answer('0', [PCMU]), carrierBefore, previousSdp), /voice codecs/);
});

test('rollback codec identity survives unmapped dynamic and static payload types', () => {
    const offer = (pts: string, maps: string[]) => media('10.0.0.3', 40000, pts, maps);
    const opus = ['a=rtpmap:111 opus/48000/2', 'a=rtpmap:101 telephone-event/48000'];
    const previous = media('10.0.0.1', 30000, '111 101', opus);
    // An answer that leaves the dynamic type unmapped keeps the mapping the offer gave it.
    assertRollbackAnswer(media('10.0.0.1', 30000, '111 101', []), previous, offer('111 101', opus));
    // Static PT 15 (G728) with an rtpmap on only one side.
    const g728 = ['a=rtpmap:15 G728/8000'];
    const g728Previous = media('10.0.0.1', 30000, '15', g728);
    assertRollbackAnswer(media('10.0.0.1', 30000, '15', []), g728Previous, offer('15', g728));
    assertRollbackAnswer(media('10.0.0.1', 30000, '15', g728), g728Previous, offer('15', []));
    // R4: the application offered opus, G722 and PCMU but negotiated PCMU; an answer led by G722 is not what it decodes.
    const appOffer = offer('111 9 0 101', [...opus, 'a=rtpmap:9 G722/8000', PCMU]);
    const carrierBefore = media('10.0.0.1', 30000, '0 101', [PCMU, 'a=rtpmap:101 telephone-event/48000']);
    assert.throws(
        () =>
            assertRollbackAnswer(
                media('10.0.0.1', 30000, '9 0 101', ['a=rtpmap:9 G722/8000', PCMU, 'a=rtpmap:101 telephone-event/48000']),
                carrierBefore,
                appOffer
            ),
        /voice codecs/
    );
    assertRollbackAnswer(media('10.0.0.1', 30000, '0 101', [PCMU, 'a=rtpmap:101 telephone-event/48000']), carrierBefore, appOffer);
});

test('a rollback answer must not change the SDES keys of the carrier stream', () => {
    const withKey = (key: string) => media('10.0.0.1', 30000, '0', [PCMU, `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key}`]);
    const restore = media('10.0.0.3', 40000, '0', [PCMU, 'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:RRRR']);
    assertRollbackAnswer(withKey('AAAA'), withKey('AAAA'), restore);
    assert.throws(() => assertRollbackAnswer(withKey('BBBB'), withKey('AAAA'), restore), /SDES/);
    assert.throws(() => assertRollbackAnswer(media('10.0.0.1', 30000, '0', [PCMU]), withKey('AAAA'), restore), /SDES/);
    // Plain RTP before: an answer that adds keys switches the security mode.
    assert.throws(() => assertRollbackAnswer(withKey('BBBB'), media('10.0.0.1', 30000, '0', [PCMU]), restore), /plain stream/);
});

test('hostname connection addresses are detected, IP literals are not', () => {
    const host = (address: string, port = 4000) =>
        ['v=0', 'o=- 1 1 IN IP4 x', 's=-', `c=IN IP4 ${address}`, 't=0 0', `m=audio ${port} RTP/AVP 0`, ''].join('\r\n');
    assert.equal(usesHostnameMedia(host('media.example.com')), true);
    assert.equal(usesHostnameMedia(host('10.0.0.1')), false);
    assert.equal(usesHostnameMedia(host('10.0.0.1/127')), false);
    assert.equal(usesHostnameMedia(host('media.example.com', 0)), false, 'a rejected stream binds nothing');
    assert.equal(usesHostnameMedia(media('2001:db8::1', 4000, '0', [PCMU], 'IP6')), false);
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

const withCrypto = (text: string, key: string) => text.replace('a=sendrecv', `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${key}\r\na=sendrecv`);

/** A replacement INVITE that is cancelled, so the application restores media: first answer binds 10.0.0.8, the restore 10.0.0.9. */
async function failedReplaceWithRestore(f: Fixture, carrierAnswer: () => Promise<string>, restoreAnswer = sdp('10.0.0.9', 49000)) {
    const answers = [sdp('10.0.0.8', 48000), restoreAnswer];
    f.hub.request = (async () => ({ action: 'answer', sdp: answers.shift()! })) as never;
    f.caller.reinviteHook = carrierAnswer;
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(10);
}

test('a replace restore whose carrier answer moved its media port ends the call', async () => {
    const f = await fixture();
    await failedReplaceWithRestore(f, async () => sdp('10.0.0.1', 31000));
    assert.equal(f.registry.get('caller'), undefined);
    assert.ok(f.caller.byes >= 1);
});

test('a replace restore whose carrier answer changed the SDES key ends the call, an unchanged key keeps it', async () => {
    const changed = await fixture();
    changed.caller.remoteSdp = changed.call.remoteSdp = withCrypto(sdp('10.0.0.1'), 'AAAA');
    await failedReplaceWithRestore(changed, async () => withCrypto(sdp('10.0.0.1'), 'BBBB'));
    assert.equal(changed.registry.get('caller'), undefined);
    assert.ok(changed.caller.byes >= 1);

    const same = await fixture();
    same.caller.remoteSdp = same.call.remoteSdp = withCrypto(sdp('10.0.0.1'), 'AAAA');
    // The restore offer is the untouched leg's own description: it offers crypto too.
    await failedReplaceWithRestore(same, async () => withCrypto(sdp('10.0.0.1'), 'AAAA'), withCrypto(sdp('10.0.0.9', 49000), 'RRRR'));
    assert.ok(same.registry.get('caller'));
    assert.equal(same.caller.byes, 0);
});

test('a replace restore with an unchanged carrier answer is kept', async () => {
    const f = await fixture();
    await failedReplaceWithRestore(f, async () => sdp('10.0.0.1'));
    assert.ok(f.registry.get('caller'));
    assert.equal(f.caller.byes, 0);
    assert.match(f.registry.get('caller')!.localSdp ?? '', /c=IN IP4 10\.0\.0\.9/);
});

test('a transfer of another call is refused while a replace restore re-INVITE is in flight', async () => {
    const f = await fixture();
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.9', 49000) }) as never;
    await f.gateway.handleInvite(invite({}, 'callB', '10.0.0.5') as never, new Response(new Dialog('callB', 'gB', 'rB')) as never);
    await turn();
    assert.ok(f.registry.get('callB'));
    const gate = Promise.withResolvers<void>();
    const answers = [sdp('10.0.0.8', 48000), sdp('10.0.0.9', 49000)];
    f.hub.request = async () => ({ action: 'answer', sdp: answers.shift()! }) as never;
    f.caller.reinviteHook = async () => {
        await gate.promise;
        return sdp('10.0.0.1');
    };
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    const pending = f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(10);
    await assert.rejects(
        f.gateway.transfer({ sessionId: 'callB', mediaSessionId: 'mB', transferId: 'tB', requestUri: 'sip:center@center.example' }, 'app'),
        /shared with another SIP call/
    );
    gate.resolve();
    await pending;
    await settle(10);
    assert.ok(f.registry.get('caller'));
    assert.ok(f.registry.get('callB'));
});

test('a transfer is refused when any active call binds a hostname connection address', async () => {
    const f = await fixture();
    f.call.localSdp = sdp('10.0.0.3').replace('c=IN IP4 10.0.0.3', 'c=IN IP4 media.example.com');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /hostname/);
    assert.equal(f.caller.reinvites.length, 0);
    assert.equal(f.call.ownership, 'application');
});

const multiCodecSdp = (ip: string, port = 40000) =>
    [
        'v=0',
        `o=- 100 1 IN IP4 ${ip}`,
        's=test',
        `c=IN IP4 ${ip}`,
        't=0 0',
        `m=audio ${port} RTP/AVP 0 8 18 101`,
        'a=rtpmap:0 PCMU/8000',
        'a=rtpmap:8 PCMA/8000',
        'a=rtpmap:18 G729/8000',
        'a=rtpmap:101 telephone-event/8000',
        'a=sendrecv',
        ''
    ].join('\r\n');

test('a multi-codec carrier keeps the call on transfer rollback when rtpbridge answered one codec', async () => {
    const f = await fixture();
    f.call.remoteSdp = f.caller.remoteSdp = multiCodecSdp('10.0.0.1');
    f.center.ackFailure = new Error('ACK send rejected');
    f.caller.reinviteHook = async () => sdp('10.0.0.1');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.ok(f.registry.get('caller'), 'call kept');
    assert.equal(f.caller.byes, 0);
});

test('a multi-codec carrier keeps the call on an app-owned Replaces restore', async () => {
    const f = await fixture();
    f.call.remoteSdp = f.caller.remoteSdp = multiCodecSdp('10.0.0.1');
    await failedReplaceWithRestore(f, async () => sdp('10.0.0.1'));
    assert.ok(f.registry.get('caller'), 'call kept');
    assert.equal(f.caller.byes, 0);
});

test('a multi-codec carrier keeps the call on a REFER return rollback', async () => {
    const f = await handedOff();
    f.call.remoteSdp = f.caller.remoteSdp = multiCodecSdp('10.0.0.1');
    let reinvites = 0;
    f.caller.reinviteHook = async () => {
        if (++reinvites === 1) f.hub.isConnected = () => false;
        return sdp('10.0.0.1');
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.ok(reinvites >= 2, `restore re-INVITE sent (${reinvites})`);
    assert.ok(f.registry.get('caller'), 'call kept');
    assert.equal(f.caller.byes, 0);
});

test('a handed-off call to a hostname destination does not block another call transfer', async () => {
    const f = await fixture();
    f.center.remoteSdp = sdp('10.0.0.2', 45000).replace('c=IN IP4 10.0.0.2', 'c=IN IP4 pbx.example.net');
    await f.gateway.transfer(f.params, 'app');
    f.hub.request = async () => ({ action: 'answer', sdp: sdp('10.0.0.9', 49000) }) as never;
    await f.gateway.handleInvite(invite({}, 'callB', '10.0.0.5') as never, new Response(new Dialog('callB', 'gB', 'rB')) as never);
    await turn();
    const result = await f.gateway.transfer(
        { sessionId: 'callB', mediaSessionId: 'mB', transferId: 'tB', requestUri: 'sip:center@center.example' },
        'app'
    );
    assert.ok(result.transferId === 'tB');
});

test('a hostname media address is refused while a transfer reservation exists', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    f.delayDial(() => gate.promise);
    const transfer = f.gateway.transfer(f.params, 'app');
    await settle(10);
    f.hub.request = async () =>
        ({ action: 'answer', sdp: sdp('10.0.0.9', 40000).replace('c=IN IP4 10.0.0.9', 'c=IN IP4 media.example.com') }) as never;
    const response = new Response(new Dialog('callB', 'gB', 'rB'));
    await f.gateway.handleInvite(invite({}, 'callB', '10.0.0.5') as never, response as never);
    await turn();
    assert.ok(response.statuses.includes(488), `statuses ${response.statuses}`);
    assert.equal(f.registry.get('callB'), undefined);
    gate.resolve();
    await transfer;
});

test('rollback codec identity includes the dynamic payload type number and normalized fmtp', () => {
    const amr = (pt: string, fmtp: string) => media('10.0.0.1', 30000, pt, [`a=rtpmap:${pt} AMR/8000`, `a=fmtp:${pt} ${fmtp}`]);
    const previous = amr('97', 'octet-align=0');
    const restore = media('10.0.0.3', 40000, '97 98', [
        'a=rtpmap:97 AMR/8000',
        'a=fmtp:97 octet-align=0',
        'a=rtpmap:98 AMR/8000',
        'a=fmtp:98 octet-align=1'
    ]);
    assert.throws(() => assertRollbackAnswer(amr('98', 'octet-align=1'), previous, restore), /voice codecs/);
    assertRollbackAnswer(amr('97', 'octet-align=0'), previous, restore);
    // Same payload type and the same parameters spelled in another order or case are the same codec.
    const multi = (fmtp: string) => amr('97', fmtp);
    assertRollbackAnswer(multi('Mode-Set=0,2; octet-align=0'), multi('octet-align=0;mode-set=0,2'), multi('octet-align=0; MODE-SET=0,2'));
    assert.throws(() => assertRollbackAnswer(multi('octet-align=1'), multi('octet-align=0'), multi('octet-align=0')), /voice codecs/);
});

test('an app-owned Replaces restore with the same address but a new SDES key renegotiates the original peer', async () => {
    const f = await fixture();
    const keyed = (ip: string, port: number, key: string) => withCrypto(sdp(ip, port), key);
    f.call.localSdp = keyed('10.0.0.8', 48000, 'AAAA');
    // The restored application SDP keeps the address but carries a fresh key.
    const answers = [keyed('10.0.0.8', 48000, 'AAAA'), keyed('10.0.0.8', 48000, 'BBBB')];
    f.hub.request = (async () => ({ action: 'answer', sdp: answers.shift()! })) as never;
    f.caller.reinviteHook = async () => sdp('10.0.0.1');
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(10);
    assert.equal(f.caller.reinvites.length, 1, 'the original peer was re-INVITEd with the new key');
    assert.match(f.caller.reinvites[0], /inline:BBBB/);
});

test('a compact r Refer-To header is handled like refer-to', async () => {
    const f = await handedOff();
    const response = new Response();
    f.center.emit('request', request('REFER', '', 42, { r: '<sip:inbound@gateway.example>' }), response);
    await settle();
    assert.ok(!response.statuses.includes(400), `statuses ${response.statuses}`);
    assert.ok(response.statuses.includes(202), `statuses ${response.statuses}`);
    const g = await handedOff();
    const both = new Response();
    g.center.emit('request', request('REFER', '', 43, { r: '<sip:inbound@gateway.example>', 'refer-to': '<sip:inbound@gateway.example>' }), both);
    await settle();
    assert.ok(both.statuses.includes(400), `statuses ${both.statuses}`);
});

test('rollback codec rule: framing-relevant identity within the restore offer set (opus, extras, stereo, AMR, inbound multi-codec)', () => {
    const opusMaps = ['a=rtpmap:111 opus/48000/2', 'a=rtpmap:101 telephone-event/48000'];
    const rtpbridgeFmtp = 'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0';
    // Outbound: the app offered `111 9 0 101`; the carrier answered `111 0 101` with its own opus fmtp; the identical rollback answer is kept.
    const appOffer = media('10.0.0.3', 40000, '111 9 0 101', [...opusMaps, rtpbridgeFmtp, 'a=rtpmap:9 G722/8000', PCMU]);
    const carrier = media('10.0.0.1', 30000, '111 0 101', [...opusMaps, 'a=fmtp:111 useinbandfec=1', PCMU]);
    assertRollbackAnswer(carrier, carrier, appOffer);
    // Formats outside the restore offer (8, 18) are ignored.
    const pcmuOffer = media('10.0.0.3', 40000, '0 101', [PCMU, TELEPHONE_EVENT]);
    const pcmuCarrier = media('10.0.0.1', 30000, '0 101', [PCMU, TELEPHONE_EVENT]);
    assertRollbackAnswer(media('10.0.0.1', 30000, '0 8 18 101', [PCMU, PCMA, 'a=rtpmap:18 G729/8000', TELEPHONE_EVENT]), pcmuCarrier, pcmuOffer);
    // opus stereo=1 vs stereo=0 between the legs is ignored, but dropping PCMU from the negotiated {opus, PCMU} ends the call.
    const stereoOffer = media('10.0.0.3', 40000, '111 0 101', [...opusMaps, 'a=fmtp:111 stereo=1', PCMU]);
    assertRollbackAnswer(carrier, carrier, stereoOffer);
    assert.throws(() => assertRollbackAnswer(media('10.0.0.1', 30000, '0 101', [PCMU, TELEPHONE_EVENT]), carrier, stereoOffer), /voice codecs/);
    // AMR: PT 97 octet-align=0 -> PT 98 octet-align=1 ends; same PT with extra mode-change-capability is kept.
    const amr = (pt: string, fmtp: string) => media('10.0.0.1', 30000, pt, [`a=rtpmap:${pt} AMR/8000`, `a=fmtp:${pt} ${fmtp}`]);
    const amrRestore = media('10.0.0.3', 40000, '97 98', [
        'a=rtpmap:97 AMR/8000',
        'a=fmtp:97 octet-align=0',
        'a=rtpmap:98 AMR/8000',
        'a=fmtp:98 octet-align=1'
    ]);
    assert.throws(() => assertRollbackAnswer(amr('98', 'octet-align=1'), amr('97', 'octet-align=0'), amrRestore), /voice codecs/);
    assertRollbackAnswer(amr('97', 'octet-align=0; mode-change-capability=2'), amr('97', 'octet-align=0'), amrRestore);
    assertRollbackAnswer(amr('97', ''), amr('97', 'octet-align=0'), amrRestore); // RFC default octet-align=0
    assert.throws(() => assertRollbackAnswer(amr('97', 'octet-align=1'), amr('97', ''), amrRestore), /voice codecs/);
    // Inbound: the carrier offered `0 8 18 101`, the app answered `0 101`: `0 101` is kept, `8 101` ends (Prev={0}, Ans={}).
    const carrierMulti = media('10.0.0.1', 30000, '0 8 18 101', [PCMU, PCMA, 'a=rtpmap:18 G729/8000', TELEPHONE_EVENT]);
    assertRollbackAnswer(media('10.0.0.1', 30000, '0 101', [PCMU, TELEPHONE_EVENT]), carrierMulti, pcmuOffer);
    assert.throws(() => assertRollbackAnswer(media('10.0.0.1', 30000, '8 101', [PCMA, TELEPHONE_EVENT]), carrierMulti, pcmuOffer), /voice codecs/);
});

test('preservesMediaParameters compares what each SDP negotiated with the remote, not raw codec lists', () => {
    const opusMaps = ['a=rtpmap:111 opus/48000/2', 'a=rtpmap:101 telephone-event/48000'];
    const committed = media('10.0.0.3', 40000, '111 9 0 101', [...opusMaps, 'a=rtpmap:9 G722/8000', PCMU]);
    const carrier = media('10.0.0.1', 30000, '0 101', [PCMU, 'a=rtpmap:101 telephone-event/48000']);
    const single = media('10.0.0.3', 40000, '0 101', [PCMU, 'a=rtpmap:101 telephone-event/48000']);
    assert.equal(preservesMediaParameters(committed, single, carrier), true);
    const other = media('10.0.0.3', 40000, '8 101', [PCMA, TELEPHONE_EVENT]);
    assert.equal(preservesMediaParameters(committed, other, carrier), false);
    assert.equal(preservesMediaParameters(committed, single.replaceAll('10.0.0.3', '10.0.0.4'), carrier), false);
});

test('an app-owned Replaces restore answering the carrier-selected codec on the same endpoint needs no re-INVITE', async () => {
    const f = await fixture();
    const opusMaps = ['a=rtpmap:111 opus/48000/2', 'a=rtpmap:101 telephone-event/48000'];
    f.call.localSdp = media('10.0.0.8', 48000, '111 9 0 101', [...opusMaps, 'a=rtpmap:9 G722/8000', PCMU]);
    f.caller.remoteSdp = f.call.remoteSdp = media('10.0.0.1', 30000, '0 101', [PCMU, 'a=rtpmap:101 telephone-event/48000']);
    const answers = [sdp('10.0.0.9', 49000), media('10.0.0.8', 48000, '0 101', [PCMU, 'a=rtpmap:101 telephone-event/48000'])];
    f.hub.request = async () => ({ action: 'answer', sdp: answers.shift()! }) as never;
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(10);
    assert.equal(f.caller.reinvites.length, 0);
    assert.equal(f.caller.byes, 0);
    assert.ok(f.registry.get('caller'));
});

test('an offerless relay ACK deadline cleans up the peer even while the requester 200 is stalled', async () => {
    const f = await handedOff({ timeout: 20 });
    const gate = Promise.withResolvers<void>();
    const stalled = new Response();
    const respond = stalled.respond.bind(stalled);
    stalled.respond = async (status, options) => {
        if (status === 200) await gate.promise;
        return respond(status, options);
    };
    f.caller.emit('request', request('INVITE', '', 43), stalled);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(f.center.acks.length, 2, 'the peer rejection ACK is not held behind the stalled 200');
    assert.match(f.center.acks[1], /m=audio 0 /);
    assert.ok(f.log.indexOf('center:ack') < f.log.indexOf('center:bye'));
    assert.equal(f.registry.size, 0);
    gate.resolve();
    await settle(10);
    assert.deepEqual(stalled.statuses, [200], 'no second final response is sent to the requester');
});

test('an offerless relay peer ACK does not wait for a stalled requester 200 once the requester ACK arrived', async () => {
    const f = await handedOff();
    const gate = Promise.withResolvers<void>();
    const stalled = new Response();
    const respond = stalled.respond.bind(stalled);
    stalled.respond = async (status, options) => {
        if (status === 200) await gate.promise;
        return respond(status, options);
    };
    f.caller.emit('request', request('INVITE', '', 43), stalled);
    await turn();
    f.caller.deliverAck(43, sdp('10.0.0.1'));
    await settle(10);
    assert.equal(f.center.acks.length, 2, 'the requester ACK proves the 200 was delivered');
    assert.match(f.center.acks[1], /c=IN IP4 10\.0\.0\.1/);
    assert.equal(f.registry.size, 1);
    gate.resolve();
    await settle(10);
});

const AMR_WB = 'a=rtpmap:116 AMR-WB/16000';
const AMR_WB_OA = 'a=rtpmap:107 AMR-WB/16000';

test('rollback codec rule: duplicate encodings in the previous carrier offer do not end an identical rollback answer', () => {
    const O = media('10.0.0.3', 40000, '116 101', [AMR_WB, 'a=fmtp:116 octet-align=0', TELEPHONE_EVENT]);
    const P = media('10.0.0.1', 30000, '116 107 101', [AMR_WB, 'a=fmtp:116 octet-align=0', AMR_WB_OA, 'a=fmtp:107 octet-align=1', TELEPHONE_EVENT]);
    const A = media('10.0.0.1', 30000, '116 101', [AMR_WB, 'a=fmtp:116 octet-align=0', TELEPHONE_EVENT]);
    assertRollbackAnswer(A, P, O);
    // Two bandwidth-efficient entries that differ only in mode-set.
    const P2 = media('10.0.0.1', 30000, '116 117 101', [
        AMR_WB,
        'a=fmtp:116 octet-align=0;mode-set=0,1',
        'a=rtpmap:117 AMR-WB/16000',
        'a=fmtp:117 octet-align=0;mode-set=2',
        TELEPHONE_EVENT
    ]);
    assertRollbackAnswer(A, P2, O);
    // A real change is still caught.
    const wrong = media('10.0.0.1', 30000, '107 101', [AMR_WB_OA, 'a=fmtp:107 octet-align=1', TELEPHONE_EVENT]);
    assert.throws(() => assertRollbackAnswer(wrong, P, O), /voice codecs/);
});

test('rollback direction: the previously negotiated hold direction is accepted, a new hold is not', () => {
    const restore = sdp('10.0.0.3');
    const held = sdp('10.0.0.1').replace('a=sendrecv', 'a=inactive');
    const active = sdp('10.0.0.1');
    assertRollbackAnswer(held, held, restore);
    assertRollbackAnswer(active, active, restore);
    assert.throws(() => assertRollbackAnswer(held, active, restore), /direction/);
    // Held before: an answer that resumes media matches the restore offer but leaves the legs disagreeing.
    assert.throws(() => assertRollbackAnswer(active, held, restore), /direction/);
});

test('a failed REFER return keeps a call that was already on hold', async () => {
    const f = await handedOff();
    const held = sdp('10.0.0.1').replace('a=sendrecv', 'a=inactive');
    f.call.remoteSdp = held;
    let first = true;
    f.caller.reinviteHook = async () => {
        if (first) {
            first = false;
            return sdp('10.0.0.1', 0);
        }
        return held;
    };
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
});

test('a restore re-INVITE refused locally (memory status 0, Redis 491) while sipbridge ACKs is retried and keeps the call (transfer and REFER return)', async () => {
    // Memory backend: NOT_ACCEPTED with no SIP status; the Redis path reports a local 491.
    const refusal = (n: number) =>
        n % 2
            ? new NativeOperationError('previous INVITE ACK not positively written', false, false, 0)
            : new NativeOperationError('SIP 491: previous INVITE ACK output still pending', false, false, 491);
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => {
        if (++calls === 2) throw refusal(1);
        return sdp('10.0.0.1');
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.caller.reinvites.length, 3, 'the refused restore was retried');
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);

    const g = await handedOff();
    let returns = 0;
    g.caller.reinviteHook = async () => {
        returns++;
        if (returns === 1) return sdp('10.0.0.1', 0);
        if (returns === 2) throw refusal(2);
        return sdp('10.0.0.1');
    };
    g.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(returns, 3);
    assert.equal(g.registry.size, 1);
    assert.equal(g.caller.byes, 0);
});

test('a restore refused by local capacity is retried; an uncertain or non-491 peer final is not', async () => {
    const run = async (failure: NativeOperationError) => {
        const f = await fixture();
        f.center.ackFailure = new Error('ACK send rejected');
        let calls = 0;
        f.caller.reinviteHook = async () => {
            if (++calls === 1) return sdp('10.0.0.1');
            if (calls === 2) throw failure;
            return sdp('10.0.0.1');
        };
        await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
        await settle();
        return f;
    };
    const capacity = await run(new NativeOperationError('Native context command capacity', false, false));
    assert.equal(capacity.caller.reinvites.length, 3);
    assert.equal(capacity.registry.size, 1);
    const unavailable = await run(new NativeOperationError('Native session unavailable', false, true));
    assert.equal(unavailable.caller.reinvites.length, 3);
    assert.equal(unavailable.registry.size, 1);
    const uncertain = await run(new NativeOperationError('unknown', true));
    assert.equal(uncertain.caller.reinvites.length, 2);
    const peer486 = await run(new NativeOperationError('SIP 486', false, false, 486, false, true));
    assert.equal(peer486.caller.reinvites.length, 2);
    assert.equal(peer486.registry.size, 0);
});

test('a peer 491 to the restore waits the RFC 3261 14.1 glare delay: 2.1-4s when the gateway owns the Call-ID, else 0-2s', async () => {
    const asked: boolean[] = [];
    const f = await fixture({
        glareDelayMs: originated => {
            asked.push(originated);
            return 1;
        }
    });
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => {
        if (++calls === 2) throw new NativeOperationError('SIP 491', false, false, 491, false, true);
        return sdp('10.0.0.1');
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.deepEqual(asked, [false], 'the carrier leg is inbound: the peer owns the Call-ID');
    assert.equal(f.caller.reinvites.length, 3);
    assert.equal(f.registry.size, 1);
    const g = await handedOff({
        glareDelayMs: originated => {
            asked.push(originated);
            return 1;
        }
    });
    g.center.isOutbound = false;
    g.caller.isOutbound = true;
    let returns = 0;
    g.caller.reinviteHook = async () => {
        returns++;
        if (returns === 1) return sdp('10.0.0.1', 0);
        if (returns === 2) throw new NativeOperationError('SIP 491', false, false, 491, false, true);
        return sdp('10.0.0.1');
    };
    g.center.emit('request', refer(), new Response());
    await settle();
    assert.deepEqual(asked, [false, true]);
    assert.equal(g.registry.size, 1);
    assert.equal(g.caller.byes, 0);
});

test('a restore re-INVITE that stays refused 491 ends the call after the bounded retries', async () => {
    const f = await fixture();
    f.center.ackFailure = new Error('ACK send rejected');
    let calls = 0;
    f.caller.reinviteHook = async () => {
        if (++calls === 1) return sdp('10.0.0.1');
        throw new NativeOperationError('previous INVITE ACK not positively written', false, false, 0);
    };
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle(10);
    assert.equal(f.caller.reinvites.length, 1 + 1 + 3, 'initial restore plus three retries');
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('BYE headers that the native layer would reject fail the request without ending the call', async () => {
    const f = await fixture();
    await assert.rejects(f.gateway.bye('caller', 'test', { 'X-Long': 'a'.repeat(17_000) }), /Invalid SIP header/);
    await assert.rejects(f.gateway.bye('caller', 'test', { 'Bad Name': 'x' }), /Invalid SIP header/);
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    await f.gateway.bye('caller', 'test', { 'X-Ok': 'fine' });
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('BYE header preflight counts serialized bytes (": " and CRLF) and the header count before the call is touched', async () => {
    const f = await handedOff();
    // 62 headers: raw name+value is 16368 bytes (under the cap), serialized it is 16616 (over).
    const many = Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`X-${i}`, 'a'.repeat(260)]));
    await assert.rejects(f.gateway.bye('caller', 'test', many), InvalidHttpActionError);
    const tiny = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-${i}`, 'a']));
    await assert.rejects(f.gateway.bye('caller', 'test', tiny), /too many/);
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes + f.center.byes, 0);
});

test('an HTTP return invite waits for the in-flight transferred POST to the same owner', async () => {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { config: { ROUTES: unknown[] }; httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    gateway.config.ROUTES = [{ match: 'userPrefix', value: 'inbound', url: 'http://app.example/hook' }];
    f.hub.findRoute = () => undefined;
    f.call.controlConnectionId = undefined;
    f.call.receiverUrl = 'http://app.example/hook';
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    gateway.httpClient.postJson = async (_url, body) => {
        const event = (body as { event?: string }).event!;
        order.push(`start:${event}`);
        if (event === 'transferred') await gate.promise;
        order.push(`end:${event}`);
        if (event === 'invite') return { action: 'answer', sdp: sdp('10.0.0.3') };
        return {};
    };
    void (f.gateway as any).sendFollowUpEvent(f.call, {
        event: 'transferred',
        callId: f.call.callId,
        sipCallId: f.call.sipCallId,
        transfer: {},
        receivedAt: ''
    });
    await settle(20);
    f.center.emit('request', refer(), new Response());
    await settle(40);
    assert.deepEqual(order, ['start:transferred'], 'the return invite is held behind the transferred POST');
    gate.resolve();
    await settle(60);
    assert.ok(order.indexOf('end:transferred') < order.indexOf('start:invite'), order.join(','));
});

test('BYE headers sipbridge reserves, or that exceed its size cap, are rejected before the call is touched', async () => {
    const f = await handedOff();
    const reserved = [
        'Call-ID',
        'call-id',
        'i',
        'Max-Forwards',
        'Via',
        'v',
        'From',
        'f',
        'To',
        't',
        'CSeq',
        'Route',
        'Record-Route',
        'Contact',
        'm',
        'Content-Length',
        'l'
    ];
    for (const name of reserved) {
        await assert.rejects(f.gateway.bye('caller', 'test', { [name]: 'x' }), InvalidHttpActionError, name);
    }
    const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`X-Big-${i}`, 'a'.repeat(8000)]));
    await assert.rejects(f.gateway.bye('caller', 'test', big), /too large/);
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes + f.center.byes, 0);
    await f.gateway.bye('caller', 'test', { 'X-Ok': 'fine' });
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
});

test('a BYE with caller headers that is definitely refused is retried with the same headers', async () => {
    const f = await fixture();
    const seen: (Record<string, string> | undefined)[] = [];
    let first = true;
    f.caller.bye = async (headers?: Record<string, string>) => {
        seen.push(headers);
        if (first) {
            first = false;
            throw new NativeOperationError('headers refused', false);
        }
        f.caller.byes++;
    };
    await f.gateway.bye('caller', 'test', { 'X-Ok': 'fine' });
    assert.deepEqual(seen, [{ 'X-Ok': 'fine' }, { 'X-Ok': 'fine' }]);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.registry.size, 0);
});

test('a failed handoff BYEs the destination while the carrier restore is still retrying (glare backoff does not hold the dead dialog)', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    let invites = 0;
    f.caller.reinviteHook = async () => {
        // The first re-INVITE switches the carrier but its answer rejects audio, failing the transfer; the restore waits.
        if (++invites === 1) return sdp('10.0.0.1', 0);
        await gate.promise;
        return sdp('10.0.0.1');
    };
    const transfer = f.gateway.transfer(f.params, 'app').catch(() => undefined);
    await settle(30);
    assert.equal(f.caller.reinvites.length, 2, 'the restore is in flight');
    assert.equal(f.center.byes, 1, 'the destination was BYEd before the restore completed');
    gate.resolve();
    await transfer;
    await settle();
    assert.equal(f.center.byes, 1);
    assert.equal(f.registry.size, 1, 'the restored carrier stays with the application');
});

test('a Replaces return whose route moved during the peer authorization goes to the current owner only', async () => {
    const f = await handedOff();
    f.call.peerHost = '10.0.0.2';
    const invitedConnections: string[] = [];
    const originalRequest = f.hub.request.bind(f.hub);
    f.hub.request = async (id: string, method: string, params: unknown) => {
        if (method === 'sip.invite') invitedConnections.push(id);
        return originalRequest(id, method, params);
    };
    // The first lookup selects owner A; the peer authorization then awaits and the route moves to owner B.
    let lookups = 0;
    f.hub.findRoute = () => ({ connectionId: ++lookups === 1 ? 'owner-a' : 'owner-b', route: { url: 'control://x' } });
    f.hub.isConnected = () => true;
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        new Response(new Dialog('replacement', 'new-local', 'new-remote')) as never
    );
    assert.deepEqual(invitedConnections, ['owner-b']);
    assert.equal(f.registry.get('replacement')?.controlConnectionId, 'owner-b');
});

test('a Replaces return whose answering owner lost the route before the commit is refused and the pair stays handed off', async () => {
    const f = await handedOff();
    f.call.peerHost = '10.0.0.2';
    const originalRequest = f.hub.request.bind(f.hub);
    f.hub.request = async (id: string, method: string, params: unknown) => {
        const result = await originalRequest(id, method, params);
        f.hub.findRoute = () => undefined; // the owner cleared its route while answering
        return result;
    };
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'));
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    assert.equal(response.status, 603);
    assert.equal(f.registry.get('replacement'), undefined);
    assert.equal(f.call.ownership, 'handed-off');
});

test('a REFER return whose route moved during the 202 goes to the current owner only', async () => {
    const f = await handedOff();
    const invitedConnections: string[] = [];
    const originalRequest = f.hub.request.bind(f.hub);
    f.hub.request = async (id: string, method: string, params: unknown) => {
        if (method === 'sip.invite') invitedConnections.push(id);
        return originalRequest(id, method, params);
    };
    let lookups = 0;
    f.hub.findRoute = () => ({ connectionId: ++lookups === 1 ? 'owner-a' : 'owner-b', route: { url: 'control://x' } });
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.deepEqual(invitedConnections, ['owner-b']);
});

test('a REFER return fails when the route disappeared during the 202', async () => {
    const f = await handedOff();
    let lookups = 0;
    const invited: string[] = [];
    const originalRequest = f.hub.request.bind(f.hub);
    f.hub.request = async (id: string, method: string, params: unknown) => {
        if (method === 'sip.invite') invited.push(id);
        return originalRequest(id, method, params);
    };
    f.hub.findRoute = () => (++lookups === 1 ? { connectionId: 'owner-a', route: { url: 'control://x' } } : undefined);
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.deepEqual(invited, []);
    assert.equal(f.call.ownership, 'handed-off');
});

test('a REFER return selected on an HTTP route fails when a control owner takes the route during the pending answer', async () => {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { config: { ROUTES: unknown[] }; httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    gateway.config.ROUTES = [{ match: 'userPrefix', value: 'inbound', url: 'http://app.example/hook' }];
    f.hub.findRoute = () => undefined;
    const posted: { event?: string }[] = [];
    gateway.httpClient.postJson = async (_url, body) => {
        posted.push(body as { event?: string });
        if ((body as { event?: string }).event === 'invite') {
            // A WebSocket owner registers a matching route while the webhook is answering: it now takes precedence.
            f.hub.findRoute = () => ({ connectionId: 'ws-owner', route: { url: 'control://ws-owner' } });
            return { action: 'answer', sdp: sdp('10.0.0.3') };
        }
        return {};
    };
    f.events.length = 0;
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.ok(posted.some(body => body.event === 'invite'));
    assert.equal(f.caller.reinvites.length, 1, 'only the transfer re-INVITE: the displaced HTTP owner never reaches the carrier');
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'handed-off');
    assert.equal(f.caller.byes, 0);
    assert.equal(f.center.byes, 0);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
});

test('a delayed retry of an earlier failed transfer returns its recorded result without dialing again', async () => {
    const f = await fixture();
    f.caller.reinviteFailure = new Error('488');
    const a = { ...f.params, transferId: 'transfer-a' };
    const b = { ...f.params, transferId: 'transfer-b' };
    await assert.rejects(f.gateway.transfer(a, 'app'));
    await settle();
    await assert.rejects(f.gateway.transfer(b, 'app'));
    await settle();
    assert.equal(f.dials(), 2);
    const retried = await f.gateway.transfer(a, 'app');
    assert.equal(f.dials(), 2, 'no dial for a retried transferId');
    assert.equal(retried.transferId, 'transfer-a');
    assert.equal(retried.state, 'failed');
    // A later transfer that completes supersedes the recorded failure.
    f.caller.reinviteFailure = undefined;
    const c = await f.gateway.transfer({ ...f.params, transferId: 'transfer-c' }, 'app');
    assert.equal(c.state, 'completed');
    const dials = f.dials();
    await assert.rejects(f.gateway.transfer(a, 'app'), SipOperationConflictError);
    assert.equal(f.dials(), dials);
});

test('a failed transfer ID whose result was evicted can never dial again, and the admitted-ID table is bounded', async () => {
    const f = await fixture();
    f.failRecording();
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /recorder unavailable/);
    for (let i = 0; i < 17; i++) {
        await assert.rejects(f.gateway.transfer({ ...f.params, transferId: `later-${i}` }, 'app'), /recorder unavailable/);
    }
    const dials = f.dials();
    assert.equal(dials, 18);
    await assert.rejects(f.gateway.transfer(f.params, 'app'), (err: unknown) => err instanceof SipOperationConflictError);
    assert.equal(f.dials(), dials, 'the evicted ID never dials');
    // A recorded (recent) result is still returned as before.
    assert.equal((await f.gateway.transfer({ ...f.params, transferId: 'later-5' }, 'app')).state, 'failed');
    assert.equal(f.dials(), dials);
    // 18 IDs are admitted; fill the table to 256, then any new ID is refused without dialing.
    for (let i = 18; i < 256; i++) await assert.rejects(f.gateway.transfer({ ...f.params, transferId: `fill-${i}` }, 'app'), /recorder unavailable/);
    const full = f.dials();
    await assert.rejects(
        f.gateway.transfer({ ...f.params, transferId: 'one-too-many' }, 'app'),
        (err: unknown) => err instanceof SipOperationConflictError
    );
    assert.equal(f.dials(), full);
});

test('a retried failed transfer conflicts once any later transfer completed, even after a return and a newer failure', async () => {
    const f = await fixture();
    f.failRecording();
    await assert.rejects(f.gateway.transfer({ ...f.params, transferId: 'A' }, 'app'), /recorder unavailable/);
    f.healRecording();
    const b = await f.gateway.transfer({ ...f.params, transferId: 'B' }, 'app');
    assert.equal(b.state, 'completed');
    // Sequence 1: B is the current completed transfer.
    await assert.rejects(f.gateway.transfer({ ...f.params, transferId: 'A' }, 'app'), (err: unknown) => err instanceof SipOperationConflictError);
    // Return to the application, then a newer transfer C fails: B moves into the finished list, no longer current.
    f.center.emit('request', refer(), new Response());
    await settle();
    assert.equal(f.call.ownership, 'application');
    f.failRecording();
    await assert.rejects(f.gateway.transfer({ ...f.params, transferId: 'C' }, 'app'), /recorder unavailable/);
    assert.equal(f.call.transfer?.state, 'failed');
    const dials = f.dials();
    // Sequence 2: A's failure was superseded by the completed B, although the current transfer (C) failed.
    await assert.rejects(f.gateway.transfer({ ...f.params, transferId: 'A' }, 'app'), (err: unknown) => err instanceof SipOperationConflictError);
    // B itself (no later completion) still returns its recorded result; so does C.
    assert.equal((await f.gateway.transfer({ ...f.params, transferId: 'B' }, 'app')).state, 'completed');
    assert.equal((await f.gateway.transfer({ ...f.params, transferId: 'C' }, 'app')).state, 'failed');
    assert.equal(f.dials(), dials);
});

test('a refused final NOTIFY is retried while the referring dialog is usable; a peer failure is not', async () => {
    const f = await handedOff();
    let finals = 0;
    f.center.request = async (method: string, options: { body?: string } = {}) => {
        f.center.requests.push({ method, ...options });
        if (options.body?.includes('200 OK') && finals++ < 2) throw new NativeOperationError('native command slots full', false);
    };
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(finals, 3, 'refused twice, accepted on the third attempt');
    assert.equal(f.call.ownership, 'application');

    const g = await handedOff();
    let peerFinals = 0;
    g.center.request = async (method: string, options: { body?: string } = {}) => {
        g.center.requests.push({ method, ...options });
        if (options.body?.includes('200 OK')) {
            peerFinals++;
            throw new NativeOperationError('SIP non-success response: 481', false, false, 481, false);
        }
    };
    g.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(peerFinals, 1, 'a peer final response ends the subscription without a retry');
});

test('each return attempt carries its own returnAttemptId on its answered and terminated events', async () => {
    const f = await handedOff();
    f.events.length = 0;
    // Attempt A: the owner answers, the carrier refuses the re-INVITE.
    f.caller.reinviteFailure = new NativeOperationError('SIP non-success response: 488', false, false, 488, false, true);
    f.center.emit('request', refer(), new Response());
    await settle();
    const inviteA = f.requests.findLast(r => r.method === 'sip.invite')!.params;
    assert.ok(inviteA.returnAttemptId);
    f.caller.reinviteFailure = undefined;
    // Attempt B succeeds.
    f.center.emit('request', refer(), new Response());
    await settle();
    const inviteB = f.requests.findLast(r => r.method === 'sip.invite')!.params;
    assert.ok(inviteB.returnAttemptId);
    assert.notEqual(inviteA.returnAttemptId, inviteB.returnAttemptId);
    const terminated = sentEvents(f, 'sip.terminated') as { data: { reason: string; returnAttemptId?: string } }[];
    assert.equal(terminated.length, 1);
    assert.equal(terminated[0].data.returnAttemptId, inviteA.returnAttemptId);
    const answered = sentEvents(f, 'sip.answered') as { data: { returnAttemptId?: string } }[];
    assert.equal(answered.length, 1);
    assert.equal(answered[0].data.returnAttemptId, inviteB.returnAttemptId);
});

const lastAttemptId = (f: Fixture) => f.requests.findLast(r => r.method === 'sip.invite')!.params.returnAttemptId;
const terminatedReasons = (f: Fixture) => (sentEvents(f, 'sip.terminated') as { data: { reason: string } }[]).map(event => event.data.reason);

test('R1: a carrier that hangs up while its final NOTIFY is pending is followed by a correlated return-aborted', async () => {
    const f = await handedOff();
    f.events.length = 0;
    const gate = Promise.withResolvers<void>();
    f.caller.request = async (method: string, options: { body?: string } = {}) => {
        f.caller.requests.push({ method, ...options });
        if (options.body?.includes('200 OK')) await gate.promise;
    };
    f.caller.emit('request', refer(), new Response());
    await settle(10);
    f.caller.emit('ended', 'bye');
    gate.resolve();
    await settle(30);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
    const names = eventNames(f);
    assert.ok(names.includes('sip.bye'));
    const terminated = sentEvents(f, 'sip.terminated') as { data: { reason: string; returnAttemptId?: string } }[];
    assert.deepEqual(
        terminated.map(event => event.data.reason),
        ['return-aborted']
    );
    assert.equal(terminated[0].data.returnAttemptId, lastAttemptId(f));
    assert.ok(names.indexOf('sip.bye') < names.indexOf('sip.terminated'), 'the call end precedes the attempt outcome');
});

test('R2: sip.answered is not held behind the destination referrer final NOTIFY retries; the old-peer BYE follows them', async () => {
    const f = await handedOff({ retryDelays: [1, 2, 3] });
    f.events.length = 0;
    const gate = Promise.withResolvers<void>();
    f.center.request = async (method: string, options: { body?: string } = {}) => {
        f.center.requests.push({ method, ...options });
        if (options.body?.includes('200 OK')) {
            await gate.promise;
            throw new NativeOperationError('NOT_ACCEPTED', false, false, 0, false, false);
        }
    };
    f.center.emit('request', refer(), new Response());
    await settle(30);
    assert.equal(sentEvents(f, 'sip.answered').length, 1, 'answered precedes the NOTIFY retries');
    assert.equal(f.center.byes, 0, 'the old-peer BYE waits for the NOTIFY');
    gate.resolve();
    await settle(60);
    assert.equal(f.center.byes, 1);
    assert.ok(f.center.requests.filter(r => r.body?.includes('200 OK')).length > 1, 'the NOTIFY was retried');
    assert.equal(terminatedReasons(f).length, 0);
});

test('R3: a carrier 481 on the return re-INVITE reports the call end before return-aborted', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.reinviteFailure = gone();
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(f.registry.size, 0);
    assert.deepEqual(terminatedReasons(f), ['dialog-gone', 'return-aborted']);
});

test('R3: an application BYE during the pending return re-INVITE reports the call end before return-aborted', async () => {
    const f = await handedOff();
    f.events.length = 0;
    const gate = Promise.withResolvers<void>();
    f.caller.reinviteHook = async () => {
        await gate.promise;
        return sdp('10.0.0.1');
    };
    f.center.emit('request', refer(), new Response());
    await settle(10);
    const bye = f.gateway.bye('caller', 'app-bye');
    gate.resolve();
    await bye;
    await settle(60);
    assert.deepEqual(terminatedReasons(f), ['app-bye', 'return-aborted']);
    assert.equal(sentEvents(f, 'sip.answered').length, 0);
});

test('R4: a different return owner hears return-aborted when the call ended and return-failed when it continues', async () => {
    const ended = await handedOff();
    ended.events.length = 0;
    const toOther = [] as { connection: string; event: { event?: string; data?: { reason?: string } } }[];
    const route = { connectionId: 'other', route: { url: 'control://other' } };
    ended.hub.findRoute = () => route;
    ended.hub.sendEvent = ((id: string, event: never) => {
        toOther.push({ connection: id, event });
        ended.events.push(event);
        return true;
    }) as never;
    ended.caller.reinviteFailure = gone();
    ended.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(ended.registry.size, 0);
    assert.deepEqual(terminatedReasons(ended), ['dialog-gone', 'return-aborted']);
    assert.equal(toOther.find(entry => entry.event.data?.reason === 'return-aborted')?.connection, 'other');

    const continuing = await handedOff();
    continuing.events.length = 0;
    continuing.hub.findRoute = () => route;
    continuing.caller.reinviteFailure = new NativeOperationError('SIP non-success response: 488', false, false, 488);
    continuing.center.emit('request', refer(), new Response());
    await settle(60);
    assert.equal(continuing.registry.size, 1);
    assert.deepEqual(terminatedReasons(continuing), ['return-failed']);
});

test('Codex 2: a destination body that is not SDP is no late offer; the transfer fails before recordings or the carrier', async () => {
    const f = await fixture();
    (f.center as unknown as { answerIsSdp: boolean }).answerIsSdp = false;
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /no late offer/);
    await settle(10);
    assert.ok(!f.log.includes('stop-recording'));
    assert.equal(f.caller.reinvites.length, 0);
    assert.equal(f.center.acks.length, 0, 'sipbridge already ACKed it; no ACK answer is sent');
    assert.equal(f.center.byes, 1);
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'application');
});

test('Codex 3: transferId is limited to 128 bytes of [A-Za-z0-9._:-] on every transport', async () => {
    const f = await fixture();
    for (const transferId of ['x'.repeat(129), 'bad id', 'é', '../x', 'a\nb']) {
        await assert.rejects(f.gateway.transfer({ ...f.params, transferId }, 'app'), /transferId must be/);
    }
    assert.equal(f.dials(), 0);
    const ok = await f.gateway.transfer({ ...f.params, transferId: 'x'.repeat(128) }, 'app');
    assert.equal(ok.state, 'completed');
});

test('Codex 1: an offerless inbound call whose ACK arrives while the destination rings rolls back to the ACK SDP', async () => {
    const f = await fixture();
    f.call.remoteSdp = '';
    f.caller.remoteSdp = '';
    f.delayDial(async () => {
        f.caller.remoteSdp = sdp('10.0.0.1');
    });
    f.center.ackFailure = new Error('ACK send rejected');
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /ACK send rejected/);
    await settle();
    assert.equal(f.caller.reinvites.length, 2, 'handoff re-INVITE, then the restore');
    assert.equal(f.caller.byes, 0, 'a valid rollback against the captured baseline keeps the call');
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'application');
});

test('Codex 1: an offerless inbound call still without its negotiated SDP at switch time fails the transfer; the carrier is untouched', async () => {
    const f = await fixture();
    f.call.remoteSdp = '';
    f.caller.remoteSdp = '';
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /not yet established/);
    await settle();
    assert.equal(f.caller.reinvites.length, 0);
    assert.equal(f.caller.byes, 0);
    assert.ok(!f.log.includes('stop-recording'), 'the empty baseline is checked before recordings are stopped');
    assert.deepEqual(
        f.log.filter(entry => entry.startsWith('center')),
        ['center:ack', 'center:bye'],
        'destination ACK-then-BYE'
    );
    assert.equal(f.registry.size, 1);
    assert.equal(f.call.ownership, 'application');
});

test('Codex 2: a non-SDP 2xx body to our offerless re-INVITE is no late offer: no ACK, relay fails, call ends', async () => {
    const f = await handedOff();
    f.center.offerlessIsSdp = false;
    const acksBefore = f.center.acks.length;
    const response = new Response();
    f.caller.emit('request', request('INVITE', '', 43), response);
    await settle(100);
    assert.equal(f.center.reinvites.at(-1), '');
    assert.equal(f.center.acks.length, acksBefore, 'sipbridge already ACKed the body; no ACK answer is attempted');
    assert.equal(response.status, 488);
    assert.equal(f.registry.size, 0);
    assert.equal(f.center.byes, 1);
});

test('Codex 3: for an HTTP owner the call-level terminated POST settles before the attempt return-aborted POST', async () => {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { config: { ROUTES: unknown[] }; httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    gateway.config.ROUTES = [{ match: 'userPrefix', value: 'inbound', url: 'http://app.example/hook' }];
    f.hub.findRoute = () => undefined;
    f.call.controlConnectionId = undefined;
    f.call.receiverUrl = 'http://app.example/hook';
    const started: string[] = [];
    const finished: string[] = [];
    const gate = Promise.withResolvers<void>();
    gateway.httpClient.postJson = async (_url, body) => {
        const event = body as { event?: string; reason?: string };
        if (event.event === 'invite') return { action: 'answer', sdp: sdp('10.0.0.3') };
        const label = `${event.event}:${event.reason}`;
        started.push(label);
        if (event.reason === 'dialog-gone') await gate.promise;
        finished.push(label);
        return {};
    };
    f.caller.reinviteFailure = gone();
    f.center.emit('request', refer(), new Response());
    await settle(60);
    assert.deepEqual(started, ['terminated:dialog-gone'], 'return-aborted waits for the delayed call-level delivery');
    gate.resolve();
    await settle(30);
    assert.deepEqual(finished, ['terminated:dialog-gone', 'terminated:return-aborted']);
    assert.deepEqual(started, finished);
});

test('R1: a destination referrer whose carrier dialog is gone gets its final NOTIFY before any BYE; the owner events keep their order', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.log = f.log;
    f.caller.reinviteFailure = gone();
    f.center.emit('request', refer(), new Response());
    await settle(80);
    assert.equal(f.registry.size, 0);
    assert.deepEqual(f.log, ['center:notify-100', 'center:notify-503', 'caller:bye', 'center:bye'], 'the final NOTIFY is queued before the BYE');
    assert.equal(f.center.byes, 1);
    assert.deepEqual(terminatedReasons(f), ['dialog-gone', 'return-aborted']);
});

test('Codex 1 (r21): a carrier 481 takes the registry token before the final NOTIFY settles: a Replaces meanwhile is not claimed', async () => {
    const f = await handedOff();
    f.events.length = 0;
    f.caller.log = f.log;
    f.caller.reinviteFailure = gone();
    const gate = Promise.withResolvers<void>();
    const original = f.center.request.bind(f.center);
    f.center.request = async (method: string, options: { body?: string; headers?: Record<string, string> } = {}) => {
        if (options.body?.includes('503')) await gate.promise;
        return original(method, options);
    };
    f.center.emit('request', refer(), new Response());
    await settle(30);
    assert.equal(f.registry.size, 0, 'removed as soon as the 481 is classified, while the NOTIFY is pending');
    assert.ok(!f.log.some(entry => entry.endsWith(':bye')), 'no BYE before the final NOTIFY');
    const replacement = new Dialog('replacement', 'new-local', 'new-remote');
    const response = new Response(replacement);
    await f.gateway.handleInvite(
        invite({ replaces: 'center;to-tag=center-gateway-tag;from-tag=center-tag' }, 'replacement', '10.0.0.2') as never,
        response as never
    );
    assert.ok(response.statuses.length === 1 && [481, 603].includes(response.statuses[0]), `not claimed: ${response.statuses}`);
    assert.equal(response.answered, undefined);
    gate.resolve();
    await settle(50);
    assert.deepEqual(
        f.log.filter(e => e !== 'center:notify-100' && !e.startsWith('response')),
        ['center:notify-503', 'caller:bye', 'center:bye']
    );
    assert.deepEqual(terminatedReasons(f), ['dialog-gone', 'return-aborted']);
});

test('Codex 2 (r21): a cancelled Replaces on an offerless call refreshes the baseline from the original dialog and restores media', async () => {
    const f = await fixture();
    f.call.remoteSdp = '';
    f.caller.remoteSdp = '';
    const answers = [sdp('10.0.0.8', 48000), sdp('10.0.0.9', 49000)];
    f.hub.request = (async () => {
        // The original caller's ACK supplies its SDP while the application prepares the replacement media.
        f.caller.remoteSdp = sdp('10.0.0.1');
        return { action: 'answer', sdp: answers.shift()! };
    }) as never;
    f.caller.reinviteHook = async () => sdp('10.0.0.1');
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(20);
    assert.equal(answers.length, 0, 'the application was asked to restore the original media');
    assert.ok(f.registry.get('caller'), 'the call survives on restored media');
    assert.equal(f.caller.byes, 0);
    assert.match(f.registry.get('caller')!.localSdp ?? '', /c=IN IP4 10\.0\.0\.9/);
});

test('Codex 2 (r21): a cancelled Replaces whose baseline is still unknown ends the call instead of leaving replacement media', async () => {
    const f = await fixture();
    f.call.remoteSdp = '';
    f.caller.remoteSdp = '';
    f.hub.request = (async () => ({ action: 'answer', sdp: sdp('10.0.0.8', 48000) })) as never;
    const response = new Response(new Dialog('replacement', 'new-local', 'new-remote'), new Error('cancelled before answer'));
    await f.gateway.handleInvite(
        invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
        response as never
    );
    await settle(20);
    assert.equal(f.registry.get('caller'), undefined);
    assert.ok(f.caller.byes >= 1);
});

async function httpOwnerReferFixture() {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { config: { ROUTES: unknown[] }; httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    gateway.config.ROUTES = [{ match: 'userPrefix', value: 'inbound', url: 'http://app.example/hook' }];
    f.hub.findRoute = () => undefined;
    f.call.controlConnectionId = undefined;
    f.call.receiverUrl = 'http://app.example/hook';
    const started: string[] = [];
    const finished: string[] = [];
    const byeGate = Promise.withResolvers<void>();
    gateway.httpClient.postJson = async (_url, body) => {
        const event = body as { event?: string; reason?: string };
        if (event.event === 'invite') return { action: 'answer', sdp: sdp('10.0.0.3') };
        const label = event.event === 'bye' ? 'bye' : `${event.event}:${event.reason}`;
        started.push(label);
        if (event.event === 'bye') await byeGate.promise;
        finished.push(label);
        return {};
    };
    return { f, started, finished, byeGate };
}

test('Codex 3 (r21): carrier BYE during the final NOTIFY: return-aborted waits for the delayed bye POST', async () => {
    const { f, started, finished, byeGate } = await httpOwnerReferFixture();
    const notifyGate = Promise.withResolvers<void>();
    f.caller.request = async (method: string, options: { body?: string } = {}) => {
        f.caller.requests.push({ method, ...options });
        if (options.body?.includes('200 OK')) await notifyGate.promise;
    };
    f.caller.emit('request', refer(), new Response());
    await settle(20);
    f.caller.emit('ended', 'bye');
    notifyGate.resolve();
    await settle(30);
    assert.deepEqual(started, ['bye'], 'return-aborted is held back by the pending bye delivery');
    byeGate.resolve();
    await settle(20);
    assert.deepEqual(finished, ['bye', 'terminated:return-aborted']);
});

test('Codex 3 (r21): carrier BYE during the pending return re-INVITE: return-aborted waits for the delayed bye POST', async () => {
    const { f, started, finished, byeGate } = await httpOwnerReferFixture();
    const reinviteGate = Promise.withResolvers<void>();
    f.caller.reinviteHook = async () => {
        await reinviteGate.promise;
        return sdp('10.0.0.1');
    };
    f.center.emit('request', refer(), new Response());
    await settle(20);
    f.caller.isEnded = true;
    f.caller.emit('ended', 'bye');
    reinviteGate.resolve();
    await settle(30);
    assert.deepEqual(started, ['bye']);
    byeGate.resolve();
    await settle(20);
    assert.deepEqual(finished, ['bye', 'terminated:return-aborted']);
});

test('Codex 1 (r22): a BYE header with an unpaired surrogate is rejected before the registry token is taken', async () => {
    const f = await fixture();
    await assert.rejects(f.gateway.bye('caller', 'test', { 'X-Bad': '\ud800' }), InvalidHttpActionError);
    await assert.rejects(f.gateway.bye('caller', 'test', { 'X-Bad': 'ok\udc00x' }), InvalidHttpActionError);
    assert.equal(f.registry.size, 1);
    assert.equal(f.caller.byes, 0);
    await f.gateway.bye('caller', 'test', { 'X-Ok': 'fine 😀' });
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
});

test('Codex 2 (r22): a non-SDP re-INVITE or UPDATE body is refused with 415 before any cross-leg command', async () => {
    for (const method of ['INVITE', 'UPDATE']) {
        const f = await handedOff();
        const before = f.center.reinvites.length;
        const response = new Response();
        f.caller.emit('request', request(method, sdp('10.0.0.1'), 44, { 'content-type': 'text/plain' }), response);
        await turn();
        assert.equal(response.status, 415, method);
        assert.equal(response.options?.headers?.Accept, 'application/sdp');
        assert.equal(f.center.reinvites.length, before, 'no command on the other leg');
        assert.equal(f.registry.size, 1);
    }
});

test('Codex 3 (r22): a delayed HTTP answered POST is delivered before the call-level bye', async () => {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { config: { ROUTES: unknown[] }; httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    gateway.config.ROUTES = [{ match: 'userPrefix', value: 'inbound', url: 'http://app.example/hook' }];
    f.hub.findRoute = () => undefined;
    f.call.controlConnectionId = undefined;
    f.call.receiverUrl = 'http://app.example/hook';
    const started: string[] = [];
    const finished: string[] = [];
    const gate = Promise.withResolvers<void>();
    gateway.httpClient.postJson = async (_url, body) => {
        const event = (body as { event?: string }).event!;
        if (event === 'invite') return { action: 'answer', sdp: sdp('10.0.0.3') };
        started.push(event);
        if (event === 'answered') await gate.promise;
        finished.push(event);
        return {};
    };
    f.center.emit('request', refer(), new Response());
    await settle(30);
    assert.ok(started.includes('answered'));
    f.caller.emit('ended', 'bye');
    await settle(30);
    assert.equal(f.registry.size, 0, 'SIP cleanup does not wait for the delivery');
    assert.deepEqual(started, ['answered'], 'bye is held behind the answered POST');
    gate.resolve();
    await settle(30);
    assert.deepEqual(finished, ['answered', 'bye']);
});

test('R1 (r23): an application-owned re-INVITE or UPDATE with a non-SDP body is refused with 415 before the owner is consulted', async () => {
    for (const method of ['INVITE', 'UPDATE']) {
        const f = await fixture();
        const events: string[] = [];
        const gateway = f.gateway as unknown as { sendFollowUpEvent: (...args: unknown[]) => Promise<unknown> };
        gateway.sendFollowUpEvent = async (_call, event) => {
            events.push((event as { event: string }).event);
            return { action: 'accept', status: 200, sdp: sdp('10.0.0.9') };
        };
        const response = new Response();
        f.caller.emit('request', request(method, sdp('10.0.0.1'), 44, { 'content-type': 'text/plain' }), response);
        await turn();
        assert.equal(response.status, 415, method);
        assert.equal(response.options?.headers?.Accept, 'application/sdp');
        assert.deepEqual(events, [], 'the application never saw the request');
    }
});

test('R2 (r23): a delayed HTTP transferred POST is delivered before the call-level bye', async () => {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    f.hub.findRoute = () => undefined;
    f.call.controlConnectionId = undefined;
    f.call.receiverUrl = 'http://app.example/hook';
    const started: string[] = [];
    const finished: string[] = [];
    const gate = Promise.withResolvers<void>();
    gateway.httpClient.postJson = async (_url, body) => {
        const event = (body as { event?: string }).event!;
        started.push(event);
        if (event === 'transferred') await gate.promise;
        finished.push(event);
        return {};
    };
    void (f.gateway as any).sendFollowUpEvent(f.call, {
        event: 'transferred',
        callId: f.call.callId,
        sipCallId: f.call.sipCallId,
        transfer: {},
        receivedAt: ''
    });
    await settle(20);
    f.caller.emit('ended', 'bye');
    await settle(30);
    assert.deepEqual(started, ['transferred'], 'bye is held behind the transferred POST');
    gate.resolve();
    await settle(30);
    assert.deepEqual(finished, ['transferred', 'bye']);
});

test('Codex 1 (r23): a declined return keeps the pair lock until the referrer final NOTIFY settles; re-INVITEs get 491 meanwhile', async () => {
    const f = await handedOff();
    f.hub.request = async () => ({ action: 'reject', status: 486 }) as never;
    const gate = Promise.withResolvers<void>();
    const notifies: string[] = [];
    f.center.request = async (method: string, options: { body?: string } = {}) => {
        f.center.requests.push({ method, ...options });
        notifies.push(options.body ?? '');
        await gate.promise;
    };
    f.center.emit('request', refer(), new Response());
    await settle(30);
    const blocked = new Response();
    f.caller.emit('request', request('INVITE', '', 51), blocked);
    await turn();
    assert.equal(blocked.status, 491, 'the pair lock is held while the progress/final NOTIFY is pending');
    assert.equal(notifies.length, 1, 'only the progress NOTIFY is on the wire so far');
    gate.resolve();
    await settle(60);
    assert.equal(notifies.length, 2, 'the final NOTIFY followed');
    assert.equal(f.registry.size, 1);
    const reinvites = f.center.reinvites.length;
    const after = new Response();
    f.caller.emit('request', request('INVITE', sdp('10.0.0.1'), 52), after);
    await settle(30);
    assert.notEqual(after.status, 491, 'the lock is released once the final NOTIFY settled');
    assert.ok(f.center.reinvites.length >= reinvites);
});

async function staleHttpOwnerFixture() {
    const f = await handedOff();
    const gateway = f.gateway as unknown as { config: { ROUTES: unknown[] }; httpClient: { postJson: (...args: unknown[]) => Promise<unknown> } };
    gateway.config.ROUTES = [{ match: 'userPrefix', value: 'inbound', url: 'http://app.example/hook' }];
    const wsRoute = f.hub.findRoute;
    f.hub.findRoute = () => undefined;
    f.call.controlConnectionId = undefined;
    f.call.receiverUrl = 'http://app.example/hook';
    const gate = Promise.withResolvers<void>();
    const httpPosts: string[] = [];
    const wsRequests: string[] = [];
    gateway.httpClient.postJson = async (_url, body) => {
        const event = (body as { event?: string }).event!;
        httpPosts.push(event);
        if (event === 'transferred') await gate.promise;
        if (event === 'invite') return { action: 'answer', sdp: sdp('10.0.0.3') };
        return {};
    };
    f.hub.request = (async (_id: string, method: string) => {
        wsRequests.push(method);
        return { action: 'answer', sdp: sdp('10.0.0.3') };
    }) as never;
    void (f.gateway as any).sendFollowUpEvent(f.call, {
        event: 'transferred',
        callId: f.call.callId,
        sipCallId: f.call.sipCallId,
        transfer: {},
        receivedAt: ''
    });
    await settle(20);
    return { f, gate, httpPosts, wsRequests, registerWs: () => (f.hub.findRoute = wsRoute) };
}

for (const path of ['refer', 'replaces'] as const) {
    const start = (f: Fixture) => {
        if (path === 'refer') f.center.emit('request', refer(), new Response());
        else
            void f.gateway.handleInvite(
                invite({ replaces: 'caller;to-tag=gateway-tag;from-tag=caller-tag' }, 'replacement', '10.0.0.1') as never,
                new Response(new Dialog('replacement', 'new-local', 'new-remote')) as never
            );
    };

    test(`r26 (${path}): a WS owner registering during the transferred settle gets the return invite, the stale HTTP owner none`, async () => {
        const { f, gate, httpPosts, wsRequests, registerWs } = await staleHttpOwnerFixture();
        start(f);
        await settle(30);
        assert.deepEqual(httpPosts, ['transferred'], 'the invite is held behind the transferred POST');
        registerWs();
        gate.resolve();
        await settle(60);
        assert.deepEqual(httpPosts, ['transferred'], 'the stale HTTP owner receives no invite');
        assert.deepEqual(wsRequests, ['sip.invite'], 'the WS owner receives the return invite');
    });

    test(`r26 (${path}): a carrier BYE during the transferred settle sends no return invite`, async () => {
        const { f, gate, httpPosts, wsRequests } = await staleHttpOwnerFixture();
        start(f);
        await settle(30);
        f.caller.isEnded = true;
        f.caller.emit('ended', 'bye');
        gate.resolve();
        await settle(60);
        assert.equal(httpPosts.includes('invite'), false);
        assert.deepEqual(wsRequests, []);
    });
}

test('r26: a BYE with caller headers refused through the whole schedule is retried once without them (headerless schedule)', async () => {
    const f = await fixture();
    const seen: Array<Record<string, string> | undefined> = [];
    f.caller.bye = async (headers?: Record<string, string>) => {
        seen.push(headers);
        if (headers) throw new NativeOperationError('invalid SIP send fingerprint input', false, true);
    };
    await f.gateway.bye('caller', 'app-hangup', { 'X-Reason': 'a' });
    assert.equal(seen.filter(h => h).length, 4, 'headers: one attempt plus three retries');
    assert.equal(seen.filter(h => !h).length, 1, 'then one headerless BYE, which succeeds');
    assert.equal(f.registry.size, 0);
});

test('r26: an uncertain BYE refusal never drops the caller headers', async () => {
    const f = await fixture();
    const seen: Array<Record<string, string> | undefined> = [];
    f.caller.bye = async (headers?: Record<string, string>) => {
        seen.push(headers);
        throw new NativeOperationError('unknown', true);
    };
    await assert.rejects(f.gateway.bye('caller', 'app-hangup', { 'X-Reason': 'a' }));
    assert.equal(seen.filter(h => !h).length, 0);
});
