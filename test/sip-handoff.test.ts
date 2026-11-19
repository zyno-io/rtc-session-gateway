import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CallRegistry } from '../src/call-registry';
import { GatewayLifecycle } from '../src/gateway-lifecycle';
import { controlErrorForCommand } from '../src/session-commands';
import { SipGateway, SipOperationConflictError } from '../src/sip-gateway';
import { isSipTransferStatus } from '../src/sip-handoff-contract';
import { assertDirectMediaAnswer, parseReferTarget, parseReplaces, rejectSdpOffer, relaySdp } from '../src/sip-sdp';
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
    fenceOnAckFailure = false;
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
            if (this.fenceOnReinviteFailure) this.isFenced = true;
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
        if (this.ackFailure) {
            if (this.fenceOnAckFailure) this.isFenced = true;
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

async function fixture(options: { timeout?: number; lifecycle?: GatewayLifecycle; firewall?: SipFirewall; centerAddress?: string } = {}) {
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
        },
        async prepareHandoff() {
            log.push('stop-recording');
            if (prepareHook) await prepareHook();
            if (prepareFailure) throw prepareFailure;
            return [finalized];
        },
        releaseHandoff() {},
        async destroySession() {
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
        { mediaController: media as never, handoffAckTimeoutMs: options.timeout ?? 1000, firewall: options.firewall }
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
        cancelled: () => cancelled,
        dials: () => opened.length,
        failRecording: () => {
            prepareFailure = new Error('recorder unavailable');
        },
        delayRecording: (hook: () => Promise<void>) => {
            prepareHook = hook;
        },
        failReplacement: () => {
            replacementFailure = new Error('Replacement dialog failed');
        },
        replacementResponse: (dialog?: Dialog) => new Response(dialog, replacementFailure),
        delayDial: (hook: () => Promise<void>) => {
            dialHook = hook;
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
        ['not a replaces header', '10.0.0.8', 400]
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

test('a colliding outbound attempt ID cannot strand a call in transferring', async () => {
    const f = await fixture();
    const attempts = (f.gateway as unknown as { pendingOutboundCalls: Map<string, unknown> }).pendingOutboundCalls;
    attempts.set('handoff:caller', { cancelRequested: false });
    await assert.rejects(f.gateway.transfer(f.params, 'app'), /already exists/);
    assert.equal(f.call.ownership, 'application');
    attempts.delete('handoff:caller');
    f.caller.reinviteHook = async () => sdp('10.0.0.1');
    assert.equal((await f.gateway.transfer(f.params, 'app')).state, 'completed');
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

test('a definitely refused destination ACK is still followed by a BYE on that leg', async () => {
    const f = await fixture();
    f.center.ackFailure = new NativeOperationError('ACK refused');
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.center.byes, 1, 'nothing else cleans the unacknowledged leg up');
});

test('an uncertain destination ACK fences the leg and it is never commanded', async () => {
    const f = await fixture();
    f.center.ackFailure = new NativeOperationError('ACK unknown', true);
    f.center.fenceOnAckFailure = true;
    await assert.rejects(f.gateway.transfer(f.params, 'app'));
    assert.equal(f.center.byes, 0);
});

test('a refused peer ACK on an offerless relay still BYEs that leg and ends the call', async () => {
    const f = await handedOff();
    f.center.ackFailure = new NativeOperationError('ACK refused');
    f.caller.emit('request', request('INVITE', '', 43), new Response());
    await turn();
    f.caller.deliverAck(43, sdp('10.0.0.1'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.registry.size, 0);
    assert.equal(f.caller.byes, 1);
    assert.equal(f.center.byes, 1);
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
