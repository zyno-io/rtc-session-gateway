import assert from 'node:assert/strict';
import { test } from 'node:test';
const native = {
    timeout: 20000,
    skip: process.env.SIPBRIDGE_TEST_BINARY ? false : 'Run yarn test:native with the pinned native runtime'
};
import { loadConfig } from '../src/config';
import { InvalidCallStateError, SipGateway } from '../src/sip-gateway';
import { CallRegistry } from '../src/call-registry';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { loadFirewallConfig, SipFirewall } from '../src/sip-firewall';
import { randomUUID } from 'node:crypto';
import { NativeOperationError, SipbridgeSignaling } from '../src/sipbridge-signaling';
import { SipbridgeControlNotSentError } from '../src/sipbridge/client';
import { nativeFixture, scriptedUa, sipPeer, udpUas, until } from './support/native-fixture';

const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=RTC\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 20000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
test('native memory SIP accepts, ACKs and remotely terminates an inbound dialog over mTLS control', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const config = loadConfig({
        ...fixture.tls,
        ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]'
    });
    const events: unknown[] = [];
    const gateway = new SipGateway(config, registry, {
        async postJson(_url: string, body: unknown) {
            events.push(body);
            return { action: 'answer', sdp };
        }
    } as never);
    const peer = await sipPeer(fixture.sipPort);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        peer.send('INVITE', 1, '', sdp);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
        const answer = peer.messages.find(message => message.startsWith('SIP/2.0 200'))!;
        const remoteTag = /^To:.*;tag=([^;\r\n]+)/im.exec(answer)?.[1];
        assert.ok(remoteTag);
        peer.send('ACK', 1, remoteTag, '', 'z9hG4bK-ack');
        await until(() => registry.size === 1);
        peer.send('BYE', 2, remoteTag, '', 'z9hG4bK-bye');
        await until(() => registry.size === 0);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200') && /CSeq: 2 BYE/i.test(message)));
    } catch (error) {
        console.error(fixture.logs);
        console.error(peer.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

test('native outbound origination, ACK, re-INVITE and BYE use the original native context', native, async () => {
    const { udpUas } = await import('./support/native-fixture');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp);
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const call = await gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip',
            callingNumber: '15551234567',
            callingName: 'RTC Test'
        });
        assert.equal(call.sdp, sdp);
        assert.equal(registry.size, 1);
        await until(() => uas.messages.some(wire => wire.startsWith('ACK ')));
        const result = await gateway.reinvite(call.sessionId, sdp);
        assert.equal(result.sdp, sdp);
        await gateway.bye(call.sessionId);
        assert.equal(registry.size, 0);
        await until(() => uas.messages.some(wire => wire.startsWith('BYE ')));
    } catch (error) {
        console.error(fixture.logs);
        console.error(uas.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('native outbound cancellation terminates the pending INVITE and releases application reservations', native, async () => {
    const { udpUas } = await import('./support/native-fixture');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp, false);
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const pending = gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip',
            controlConnectionId: 'owner',
            outboundAttemptId: 'attempt'
        });
        const rejected = assert.rejects(pending);
        await until(() => uas.messages.some(wire => wire.startsWith('INVITE ')));
        await gateway.cancelOutbound('attempt', 'owner');
        await rejected;
        assert.ok(uas.messages.some(wire => wire.startsWith('CANCEL ')));
        assert.equal(registry.size, 0);
        assert.equal(registry.pendingCount, 0);
    } catch (error) {
        console.error(fixture.logs);
        console.error(uas.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('native bootstrap connects to a non-admitting catalog and becomes eligible after admission changes', native, async () => {
    const { SipbridgeSignaling } = await import('../src/sipbridge-signaling');
    const fixture = await nativeFixture();
    fixture.publish(false);
    const signaling = new SipbridgeSignaling(loadConfig(fixture.tls));
    try {
        await signaling.start();
        await until(async () => (await fetch(`http://127.0.0.1:${fixture.adminPort}/sip-readyz`)).ok);
        assert.equal(signaling.isConnected, false);
        fixture.publish(true);
        await until(() => signaling.isConnected);
    } finally {
        await signaling.stop();
        await fixture.close();
    }
});

test('expired signaling withdraws new calls while the original native dialog remains usable', native, async () => {
    const { udpUas } = await import('./support/native-fixture');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp);
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const params = {
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip'
        };
        const call = await gateway.createOutbound(params);
        fixture.publish(true, Date.now() + 30000, Date.now() - 1000);
        await until(() => !gateway.isConnected);
        await assert.rejects(gateway.createOutbound(params), /admission unavailable/);
        assert.equal((await gateway.reinvite(call.sessionId, sdp)).sdp, sdp);
        await gateway.bye(call.sessionId);
        assert.equal(registry.size, 0);
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('native TLS rejects a wrong server name and an unauthorized client URI', native, async () => {
    const { SipbridgeControlClient } = await import('../src/sipbridge/client');
    const fixture = await nativeFixture();
    const options = {
        url: `wss://127.0.0.1:${fixture.controlPort}/v1/control`,
        process: { instanceId: 'rtc-test', epoch: 'test-epoch' },
        connectionAttempt: 1n,
        certificateFile: fixture.tls.SIPBRIDGE_TLS_CERT_FILE,
        keyFile: fixture.tls.SIPBRIDGE_TLS_KEY_FILE,
        serverTrustFile: fixture.tls.SIPBRIDGE_TLS_CA_FILE,
        serverName: 'localhost',
        helloTimeoutMs: 500
    };
    try {
        await assert.rejects(SipbridgeControlClient.connect({ ...options, serverName: 'wrong.test' }));
        await assert.rejects(
            SipbridgeControlClient.connect({
                ...options,
                certificateFile: fixture.directory + '/server.crt',
                keyFile: fixture.directory + '/server.key'
            })
        );
    } finally {
        await fixture.close();
    }
});

test('duplicate request notification runs policy once and native CANCEL wins while owner decision is pending', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const decision = Promise.withResolvers<{ action: string; sdp: string }>();
    let invites = 0;
    const config = loadConfig({
        ...fixture.tls,
        ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]'
    });
    const gateway = new SipGateway(config, registry, {
        async postJson(_url: string, body: { event: string }) {
            if (body.event === 'invite') {
                invites++;
                return decision.promise;
            }
            return {};
        }
    } as never);
    const peer = await sipPeer(fixture.sipPort);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        peer.send('INVITE', 1, '', sdp);
        await until(() => invites === 1);
        peer.send('INVITE', 1, '', sdp);
        peer.send('CANCEL');
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 487')));
        decision.resolve({ action: 'answer', sdp });
        await until(() => registry.pendingCount === 0);
        assert.equal(invites, 1);
        assert.equal(registry.size, 0);
        assert.equal(
            peer.messages.some(message => message.startsWith('SIP/2.0 200') && /CSeq: 1 INVITE/i.test(message)),
            false
        );
    } finally {
        decision.resolve({ action: 'answer', sdp });
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

test('a fresh request refused by admission policy receives its selected SIP status without reaching the owner', native, async () => {
    const { SipbridgeSignaling } = await import('../src/sipbridge-signaling');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    let invites = 0;
    const config = loadConfig({
        ...fixture.tls,
        ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]'
    });
    const signaling = new SipbridgeSignaling(config);
    signaling.acceptingIngress = () => false;
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson(_url: string, body: { event: string }) {
                if (body.event === 'invite') invites++;
                return {};
            }
        } as never,
        signaling
    );
    const peer = await sipPeer(fixture.sipPort);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        peer.send('INVITE', 1, '', sdp);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 503')), 1500);
        assert.equal(invites, 0);
        assert.equal(registry.size, 0);
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

test('owner disconnect sends native BYE and clears application call ownership', native, async () => {
    const { udpUas } = await import('./support/native-fixture');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp);
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        await gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            controlConnectionId: 'owner'
        });
        await gateway.terminateCallsForControlConnection('owner');
        await until(() => uas.messages.some(wire => wire.startsWith('BYE ')));
        assert.equal(registry.size, 0);
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('native control session loss ends that term natively and a reconnect admits fresh calls without replay', native, async () => {
    const { SipbridgeSignaling } = await import('../src/sipbridge-signaling');
    const { udpUas } = await import('./support/native-fixture');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp);
    const config = loadConfig(fixture.tls);
    const signaling = new SipbridgeSignaling(config);
    let connections = 0;
    signaling.on('connected', () => connections++);
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson() {
                return {};
            }
        } as never,
        signaling
    );
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const call = await gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip'
        });
        for (const peer of (signaling as any).peers.values()) peer.client.close();
        await until(() => connections >= 2);
        // Memory sipbridge expires an established session's application term and ends its calls natively.
        await until(() => registry.size === 0 && uas.messages.some(wire => wire.startsWith('BYE ')));
        assert.equal(uas.messages.filter(wire => wire.startsWith('INVITE ')).length, 1);
        await assert.rejects(gateway.reinvite(call.sessionId, sdp));
        await until(() => gateway.isConnected);
        const fresh = await gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip'
        });
        assert.equal(registry.size, 1);
        await gateway.bye(fresh.sessionId);
        assert.equal(registry.size, 0);
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('memory-core restart invalidates old contexts and permits fresh calls on the new authority', native, async () => {
    const { SipbridgeSignaling } = await import('../src/sipbridge-signaling');
    const { udpUas } = await import('./support/native-fixture');
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp);
    const config = loadConfig(fixture.tls);
    const signaling = new SipbridgeSignaling(config);
    let connections = 0;
    signaling.on('connected', () => connections++);
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson() {
                return {};
            }
        } as never,
        signaling
    );
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const params = {
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip'
        };
        const old = await gateway.createOutbound(params);
        await fixture.restart();
        await until(() => connections >= 2);
        await until(() => registry.size === 0);
        await assert.rejects(gateway.reinvite(old.sessionId, sdp), /not found/);
        assert.equal(uas.messages.filter(wire => wire.startsWith('INVITE ')).length, 1);
        const fresh = await gateway.createOutbound(params);
        await gateway.bye(fresh.sessionId);
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('native outbound digest authentication resolves transient credentials for the exact context', native, async () => {
    const { udpUas } = await import('./support/native-fixture');
    const auth = { username: 'rtc-fixture-user', password: 'synthetic-fixture-password' };
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const uas = await udpUas(sdp, true, auth);
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const call = await gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`,
            sdp,
            receiverUrl: 'https://owner.test/sip',
            auth
        });
        assert.ok(uas.messages.some(wire => /^Authorization: Digest /im.test(wire)));
        assert.equal(
            uas.messages.some(wire => wire.includes(auth.password)),
            false
        );
        await gateway.bye(call.sessionId);
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

const contextCount = (signaling: SipbridgeSignaling) => (signaling as any).contexts.size as number;
const toTagOf = (wire: string) => /^To:.*;tag=([^;\r\n]+)/im.exec(wire)?.[1];

test(
    'a session lost to reconnect leaves no stale-term cascade: later calls survive the old term event retries',
    { ...native, timeout: 60000 },
    async () => {
        const fixture = await nativeFixture();
        const registry = new CallRegistry();
        const config = loadConfig(fixture.tls);
        const signaling = new SipbridgeSignaling(config);
        let connections = 0;
        let disconnections = 0;
        signaling.on('connected', () => connections++);
        signaling.on('disconnected', () => disconnections++);
        const gateway = new SipGateway(
            config,
            registry,
            {
                async postJson() {
                    return {};
                }
            } as never,
            signaling
        );
        const uas = await udpUas(sdp);
        const dial = () =>
            gateway.createOutbound({ requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`, sdp, receiverUrl: 'https://owner.test/sip' });
        try {
            await gateway.start();
            await until(() => gateway.isConnected);
            await dial();
            for (const peer of (signaling as any).peers.values()) peer.client.close();
            await until(() => connections >= 2);
            assert.equal(registry.size, 0);
            assert.equal(contextCount(signaling), 0);
            const fresh = await dial();
            // sipbridge redelivers the old term's lifecycle events for roughly two minutes; they must not disturb this session.
            await new Promise(resolve => setTimeout(resolve, 18000));
            assert.equal(registry.size, 1);
            assert.equal(connections, 2);
            assert.equal(disconnections, 1);
            assert.equal(uas.messages.filter(wire => wire.startsWith('BYE ')).length, 1);
            await gateway.bye(fresh.sessionId);
            assert.equal(registry.size, 0);
        } finally {
            await gateway.shutdown();
            uas.close();
            await fixture.close();
        }
    }
);

test('rejected first requests leave no contexts and capacity refusals do not close the session', { ...native, timeout: 60000 }, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
    const signaling = new SipbridgeSignaling(config);
    let deny = true;
    signaling.acceptingIngress = () => !deny;
    let disconnections = 0;
    signaling.on('disconnected', () => disconnections++);
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson() {
                return { action: 'reject', status: 486 };
            }
        } as never,
        signaling
    );
    const uas = await udpUas(sdp);
    const peers = await Promise.all(Array.from({ length: 6 }, () => sipPeer(fixture.sipPort)));
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        await gateway.createOutbound({ requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`, sdp, receiverUrl: 'https://owner.test/sip' });
        assert.equal(contextCount(signaling), 1);
        // Admission denial, owner rejection and an unsupported first request.
        for (const peer of peers.slice(0, 3)) peer.send('INVITE', 1, '', sdp);
        await until(() => peers.slice(0, 3).every(peer => peer.messages.some(message => message.startsWith('SIP/2.0 503'))));
        deny = false;
        for (const peer of peers.slice(3, 5)) peer.send('INVITE', 1, '', sdp);
        await until(() => peers.slice(3, 5).every(peer => peer.messages.some(message => message.startsWith('SIP/2.0 486'))));
        peers[5].send('MESSAGE', 1, '', 'hi');
        await until(() => peers[5].messages.some(message => /^SIP\/2.0 [2-6]/.test(message)));
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal(contextCount(signaling), 1);
        // At capacity a fresh request is refused with 503 and nothing else is disturbed.
        const contexts = (signaling as any).contexts as Map<string, any>;
        const live = [...contexts.values()][0];
        for (let i = 0; contexts.size < 1024; i++)
            contexts.set('filler' + i, { ...live, snapshot: { ...live.snapshot, context: { ...live.snapshot.context, id: 'filler' + i } } });
        const extra = await sipPeer(fixture.sipPort);
        peers.push(extra);
        extra.send('INVITE', 1, '', sdp);
        await until(() => extra.messages.some(message => message.startsWith('SIP/2.0 503')), 3000);
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(disconnections, 0);
        assert.equal(registry.size, 1);
        assert.equal(
            uas.messages.some(wire => wire.startsWith('BYE ')),
            false
        );
    } finally {
        await gateway.shutdown();
        uas.close();
        for (const peer of peers) peer.close();
        await fixture.close();
    }
});

test('a flood of refused first requests beyond the context limit does not block the next real call', { ...native, timeout: 90000 }, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
    const signaling = new SipbridgeSignaling(config);
    let ownerCalls = 0;
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson() {
                ownerCalls++;
                return { action: 'reject', status: 486 };
            }
        } as never,
        signaling
    );
    const peers: Awaited<ReturnType<typeof sipPeer>>[] = [];
    const final = (peer: (typeof peers)[number]) => peer.messages.some(message => /^SIP\/2.0 [3-6]/.test(message));
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        // 160 distinct refused calls exceed SIPBRIDGE_MEMORY_MAX_GROUPS (128). Refusals keep their transaction state for
        // the SIP timers (~32s on UDP), so they must not hold the slots a new call needs. Batches stay under the
        // per-source limit on requests awaiting a controller decision.
        for (let batch = 0; batch < 8; batch++) {
            const group = await Promise.all(Array.from({ length: 20 }, () => sipPeer(fixture.sipPort)));
            peers.push(...group);
            for (const peer of group) peer.send('INVITE', 1, '', sdp);
            await until(() => group.every(final), 10000);
        }
        assert.equal(peers.filter(peer => peer.messages.some(message => message.startsWith('SIP/2.0 486'))).length, 160);
        const real = await sipPeer(fixture.sipPort);
        peers.push(real);
        const before = ownerCalls;
        real.send('INVITE', 1, '', sdp);
        await until(() => final(real), 5000);
        assert.ok(
            real.messages.some(message => message.startsWith('SIP/2.0 486')),
            'the real call reached the owner: ' + real.messages.map(message => message.split('\r\n')[0]).join(', ')
        );
        assert.ok(ownerCalls > before);
    } finally {
        await gateway.shutdown();
        for (const peer of peers) peer.close();
        await fixture.close();
    }
});

test('a request on a different flow is refused immediately', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
    const gateway = new SipGateway(config, registry, {
        async postJson() {
            return { action: 'answer', sdp };
        }
    } as never);
    const peer = await sipPeer(fixture.sipPort);
    const other = createSocket('udp4');
    await new Promise<void>(resolve => other.bind(0, '127.0.0.1', resolve));
    const replies: { at: number; wire: string }[] = [];
    other.on('message', bytes => replies.push({ at: Date.now(), wire: bytes.toString() }));
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        peer.send('INVITE', 1, '', sdp);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
        const toTag = toTagOf(peer.messages.find(message => message.startsWith('SIP/2.0 200'))!)!;
        peer.send('ACK', 1, toTag, '', 'z9hG4bK-ack');
        await until(() => registry.size === 1);
        const port = other.address().port;
        const wire = `BYE sip:support@localhost SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:${port};branch=z9hG4bK-${randomUUID()};rport\r\nMax-Forwards: 70\r\nFrom: <sip:caller@localhost>;tag=${/;tag=([^;>\r\n]+)/.exec(peer.messages.find(m => m.startsWith('SIP/2.0 200'))!.match(/^From:.*$/im)![0])![1]}\r\nTo: <sip:support@localhost>;tag=${toTag}\r\nCall-ID: ${peer.callId}\r\nCSeq: 2 BYE\r\nContent-Length: 0\r\n\r\n`;
        const started = Date.now();
        other.send(wire, fixture.sipPort, '127.0.0.1');
        await until(() => replies.some(reply => /^SIP\/2.0 [2-6]/.test(reply.wire)), 5000);
        const final = replies.find(reply => /^SIP\/2.0 [2-6]/.test(reply.wire))!;
        assert.ok(final.at - started < 1500, 'refused after ' + (final.at - started) + 'ms: ' + final.wire.split('\r\n')[0]);
        assert.equal(registry.size, 1);
    } finally {
        await gateway.shutdown();
        peer.close();
        other.close();
        await fixture.close();
    }
});

async function rawSender(sipPort: number) {
    const socket = createSocket('udp4');
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    const messages: string[] = [];
    socket.on('message', bytes => messages.push(bytes.toString()));
    function send(method: string, user = 'support') {
        const body = method === 'INVITE' ? sdp : '';
        const wire = `${method} sip:${user}@localhost SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:${port};branch=z9hG4bK-${randomUUID()};rport\r\nMax-Forwards: 70\r\nFrom: <sip:caller@localhost>;tag=${randomUUID()}\r\nTo: <sip:${user}@localhost>\r\nCall-ID: ${randomUUID()}@probe\r\nCSeq: 1 ${method}\r\nContact: <sip:caller@127.0.0.1:${port};transport=udp>\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${body.length}\r\n\r\n${body}`;
        socket.send(wire, sipPort, '127.0.0.1');
    }
    return { messages, send, close: () => socket.close() };
}
const routes = '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]';

test('first requests present() would not answer are refused, so out-of-dialog BYEs hold no context', { ...native, timeout: 60000 }, async () => {
    const fixture = await nativeFixture();
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: routes });
    const signaling = new SipbridgeSignaling(config);
    const gateway = new SipGateway(
        config,
        new CallRegistry(),
        {
            async postJson() {
                return { action: 'reject', status: 486 };
            }
        } as never,
        signaling
    );
    const peer = await rawSender(fixture.sipPort);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const count = (prefix: string) => peer.messages.filter(message => message.startsWith(prefix)).length;
        // Under sipbridge's per-window native context limit (128); each must be refused and released.
        for (let i = 0; i < 100; i++) {
            peer.send('BYE');
            if (i % 5 === 4) await new Promise(resolve => setTimeout(resolve, 20));
        }
        await until(() => count('SIP/2.0 481') >= 100, 20000);
        peer.send('INFO');
        await until(() => count('SIP/2.0 481') >= 101);
        peer.send('MESSAGE');
        await until(() => count('SIP/2.0 405') >= 1);
        assert.equal(contextCount(signaling), 0);
        peer.send('INVITE');
        await until(() => count('SIP/2.0 486') >= 1);
        assert.equal(contextCount(signaling), 0);
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

test('a current-term terminal event that precedes the outbound context record fails the attempt promptly', native, async () => {
    const fixture = await nativeFixture();
    const config = loadConfig(fixture.tls);
    const signaling = new SipbridgeSignaling(config);
    const gateway = new SipGateway(
        config,
        new CallRegistry(),
        {
            async postJson() {
                return {};
            }
        } as never,
        signaling
    );
    const uas = await udpUas(sdp);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const peer = [...(signaling as any).peers.values()][0];
        const client = peer.client;
        const request = client.request.bind(client);
        client.reply = async () => undefined;
        // Deliver the FAILED event before openDialog records the context from the openUac result.
        client.request = async (payload: any, budget?: number) => {
            const envelope = await request(payload, budget);
            if (payload.$case === 'command' && payload.command.action?.$case === 'openUac' && envelope.payload?.$case === 'result') {
                await (signaling as any).receive(peer, client, {
                    correlationId: randomUUID(),
                    sessionId: '',
                    remainingBudgetMs: 0,
                    payload: {
                        $case: 'dialogEvent',
                        dialogEvent: { kind: 6, snapshot: envelope.payload.result.snapshot, error: 'early failure', operationId: '' }
                    }
                });
            }
            return envelope;
        };
        const started = Date.now();
        await assert.rejects(
            gateway.createOutbound({ requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`, sdp, receiverUrl: 'https://owner.test/sip' })
        );
        assert.ok(Date.now() - started < 5000, 'attempt took ' + (Date.now() - started) + 'ms');
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('uncertain first requests expire, not-sent failures are definite, and capacity is checked before an INVITE is sent', native, async () => {
    const fixture = await nativeFixture();
    const config = loadConfig(fixture.tls);
    const signaling = new SipbridgeSignaling(config);
    const gateway = new SipGateway(
        config,
        new CallRegistry(),
        {
            async postJson() {
                return {};
            }
        } as never,
        signaling
    );
    const uas = await udpUas(sdp);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        await gateway.createOutbound({ requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`, sdp, receiverUrl: 'https://owner.test/sip' });
        const contexts = (signaling as any).contexts as Map<string, any>;
        const live = [...contexts.values()][0];
        const uncertain = {
            ...live,
            first: true,
            dialog: undefined,
            uncertain: false,
            snapshot: { ...live.snapshot, context: { ...live.snapshot.context, id: 'uncertain' } }
        };
        contexts.set('uncertain', uncertain);
        (signaling as any).fence(uncertain);
        assert.equal(uncertain.uncertain, true);
        assert.ok(uncertain.expiresAt > Date.now());
        uncertain.expiresAt = Date.now() - 1;
        await until(() => uncertain.ended);
        const client = live.peer.client;
        const request = client.request;
        client.request = async () => {
            throw new SipbridgeControlNotSentError('control operation capacity');
        };
        await assert.rejects(signaling.command(live, { $case: 'cancel', cancel: {} }), (error: unknown) => {
            assert.ok(error instanceof NativeOperationError);
            assert.equal(error.uncertain, false);
            assert.equal(error.unavailable, true);
            return true;
        });
        assert.equal(live.uncertain, false);
        client.request = request;
        for (let i = 0; contexts.size < 1024; i++)
            contexts.set('filler' + i, { ...live, snapshot: { ...live.snapshot, context: { ...live.snapshot.context, id: 'filler' + i } } });
        const invites = () => uas.messages.filter(wire => wire.startsWith('INVITE ')).length;
        const before = invites();
        await assert.rejects(
            signaling.openDialog({ requestUri: `sip:callee@127.0.0.1:${uas.port};transport=udp`, sdp, headers: {} } as never).completed
        );
        assert.equal(invites(), before);
    } finally {
        await gateway.shutdown();
        uas.close();
        await fixture.close();
    }
});

test('a full receipt table evicts the oldest receipts instead of refusing messages', native, async () => {
    const fixture = await nativeFixture();
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: routes });
    const signaling = new SipbridgeSignaling(config);
    signaling.acceptingIngress = () => false;
    const gateway = new SipGateway(
        config,
        new CallRegistry(),
        {
            async postJson() {
                return {};
            }
        } as never,
        signaling
    );
    const peer = await rawSender(fixture.sipPort);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const events = (signaling as any).events as Map<string, unknown>;
        for (let i = 0; i < 8192; i++) events.set('old' + i, { fingerprint: 'x', expires: Date.now() + 100000 });
        peer.send('INVITE');
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 503')), 3000);
        assert.ok(events.size <= 8192);
        assert.equal(events.has('old0'), false);
        assert.equal(contextCount(signaling), 0);
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

test(
    'a re-INVITE in a dialog whose uncertain first-request context expired is refused, never offered as a new call',
    { ...native, timeout: 30000 },
    async () => {
        const fixture = await nativeFixture();
        const registry = new CallRegistry();
        const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
        const signaling = new SipbridgeSignaling(config);
        const events: string[] = [];
        const gateway = new SipGateway(
            config,
            registry,
            {
                async postJson(_url: string, body: { event?: string }) {
                    events.push(body?.event ?? '');
                    return body?.event === 'invite' ? { action: 'answer', sdp } : {};
                }
            } as never,
            signaling
        );
        const peer = await sipPeer(fixture.sipPort);
        try {
            await gateway.start();
            await until(() => gateway.isConnected);
            const client = [...(signaling as any).peers.values()][0].client;
            const request = client.request.bind(client);
            let lost = false;
            // The 200 reaches sipbridge but its result is lost, so RTC fences the first-request context.
            client.request = async (payload: any, budget?: number) => {
                const result = await request(payload, budget);
                if (
                    !lost &&
                    payload.$case === 'command' &&
                    payload.command.action?.$case === 'respond' &&
                    payload.command.action.respond.status === 200
                ) {
                    lost = true;
                    throw new Error('simulated lost result');
                }
                return result;
            };
            peer.send('INVITE', 1, '', sdp);
            await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
            const toTag = /^To:.*;tag=([^;\s]+)/im.exec(peer.messages.find(message => message.startsWith('SIP/2.0 200'))!)![1];
            peer.send('ACK', 1, toTag, '', 'z9hG4bK-' + randomUUID());
            const contexts = (signaling as any).contexts as Map<string, { expiresAt?: number }>;
            await until(() => [...contexts.values()].some(state => state.expiresAt !== undefined));
            for (const state of contexts.values()) if (state.expiresAt) state.expiresAt = Date.now() - 1;
            await until(() => contexts.size === 0, 5000);
            peer.messages.length = 0;
            peer.send('INVITE', 2, toTag, sdp, 'z9hG4bK-' + randomUUID());
            await until(() => peer.messages.some(message => /^SIP\/2\.0 [2-6]\d\d/.test(message)), 8000);
            assert.ok(peer.messages.some(message => message.startsWith('SIP/2.0 481')));
            assert.equal(events.filter(event => event === 'invite').length, 1);
            assert.equal(registry.size, 0);
        } finally {
            await gateway.shutdown();
            peer.close();
            await fixture.close();
        }
    }
);

// Loopback sources are never scored or banned, so these tests send from a non-loopback local address.
const externalAddress = Object.values(networkInterfaces())
    .flat()
    .find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
const firewallNative = { ...native, skip: native.skip || (externalAddress ? false : 'No non-loopback IPv4 address available') };

test('native firewall refuses a banned source for INVITE and other fresh methods without owner calls or RTC state', firewallNative, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL_MODE: 'enforce' }));
    firewall.ban(externalAddress, 60, 'test');
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
    const signaling = new SipbridgeSignaling(config);
    let posts = 0;
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson() {
                posts++;
                return { action: 'answer', sdp };
            }
        } as never,
        signaling,
        undefined,
        undefined,
        { firewall }
    );
    const peer = await sipPeer(fixture.sipPort, externalAddress);
    const options = await sipPeer(fixture.sipPort, externalAddress);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        peer.send('INVITE', 1, '', sdp);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 403') && /CSeq: 1 INVITE/i.test(message)), 4000);
        options.send('MESSAGE', 1, '', '', 'z9hG4bK-message');
        await until(() => options.messages.some(message => message.startsWith('SIP/2.0 403') && /CSeq: 1 MESSAGE/i.test(message)), 4000);
        assert.equal(posts, 0);
        assert.equal(registry.size, 0);
        assert.equal((signaling as unknown as { contexts: Map<string, unknown> }).contexts.size, 0);
        assert.equal(firewall.counters.observations, 0);
    } catch (error) {
        console.error(fixture.logs, peer.messages, options.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        peer.close();
        options.close();
        await fixture.close();
    }
});

test('native firewall scores each unrouted INVITE once, then refuses the banned scanner', firewallNative, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL_MODE: 'enforce', SIP_FIREWALL_THRESHOLD: '2' }));
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"other","url":"https://owner.test/sip"}]' });
    const signaling = new SipbridgeSignaling(config);
    let posts = 0;
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson() {
                posts++;
                return {};
            }
        } as never,
        signaling,
        undefined,
        undefined,
        { firewall }
    );
    const peer = await sipPeer(fixture.sipPort, externalAddress);
    const status = (status: number, cseq: number) =>
        peer.messages.filter(message => message.startsWith('SIP/2.0 ' + status) && new RegExp('CSeq: ' + cseq + ' INVITE', 'i').test(message)).length;
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        peer.send('INVITE', 1, '', sdp, 'z9hG4bK-scan1');
        await until(() => status(404, 1) > 0, 4000);
        peer.send('INVITE', 1, '', sdp, 'z9hG4bK-scan1');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(firewall.counters.observations, 1, 'a retransmission is not scored twice');
        peer.send('INVITE', 2, '', sdp, 'z9hG4bK-scan2');
        await until(() => status(404, 2) > 0, 4000);
        assert.equal(firewall.counters.observations, 2);
        assert.equal(firewall.counters.bans, 0);
        peer.send('INVITE', 3, '', sdp, 'z9hG4bK-scan3');
        await until(() => status(404, 3) > 0, 4000);
        assert.equal(firewall.counters.bans, 1);
        peer.send('INVITE', 4, '', sdp, 'z9hG4bK-scan4');
        await until(() => status(403, 4) > 0, 4000);
        assert.equal(firewall.counters.observations, 3, 'a banned source is refused without further scoring');
        assert.equal(posts, 0);
        assert.equal(registry.size, 0);
        assert.equal((signaling as unknown as { contexts: Map<string, unknown> }).contexts.size, 0);
    } catch (error) {
        console.error(fixture.logs, peer.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

function rawInvite(
    peer: Awaited<ReturnType<typeof sipPeer>>,
    host: string,
    sipPort: number,
    o: { user: string; callId: string; fromTag: string; branch: string; toTag?: string; cseq?: number }
) {
    const uri = `sip:${o.user}@localhost`;
    const wire = `INVITE ${uri} SIP/2.0\r\nVia: SIP/2.0/UDP ${host}:${peer.port};branch=${o.branch};rport\r\nMax-Forwards: 70\r\nFrom: <sip:caller@localhost>;tag=${o.fromTag}\r\nTo: <${uri}>${o.toTag ? ';tag=' + o.toTag : ''}\r\nCall-ID: ${o.callId}\r\nCSeq: ${o.cseq ?? 1} INVITE\r\nContact: <sip:caller@${host}:${peer.port};transport=udp>\r\nContent-Length: 0\r\n\r\n`;
    peer.socket.send(wire, sipPort, '127.0.0.1');
}

test('native firewall scores every distinct fresh request even with a reused Call-ID and CSeq', firewallNative, async () => {
    const fixture = await nativeFixture();
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL_MODE: 'enforce', SIP_FIREWALL_THRESHOLD: '100' }));
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"other","url":"https://owner.test/sip"}]' });
    const gateway = new SipGateway(
        config,
        new CallRegistry(),
        {
            async postJson() {
                return {};
            }
        } as never,
        new SipbridgeSignaling(config),
        undefined,
        undefined,
        { firewall }
    );
    const peer = await sipPeer(fixture.sipPort, externalAddress);
    const callId = randomUUID() + '@scan';
    const responses = () => peer.messages.filter(message => message.startsWith('SIP/2.0 404')).length;
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        for (let i = 0; i < 6; i++) {
            rawInvite(peer, externalAddress!, fixture.sipPort, {
                user: 'scan' + i,
                callId,
                fromTag: randomUUID(),
                branch: 'z9hG4bK-' + randomUUID()
            });
            await until(() => responses() > i, 4000);
        }
        assert.equal(firewall.counters.observations, 6);
        // A true retransmission (same branch) is absorbed and scored once.
        const retransmitted = { user: 'again', callId, fromTag: randomUUID(), branch: 'z9hG4bK-' + randomUUID() };
        rawInvite(peer, externalAddress!, fixture.sipPort, retransmitted);
        await until(() => responses() > 6, 4000);
        rawInvite(peer, externalAddress!, fixture.sipPort, retransmitted);
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.equal(firewall.counters.observations, 7);
    } catch (error) {
        console.error(fixture.logs, peer.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

test('native firewall leaves a forgotten-dialog re-INVITE to the 481 refusal, unscored', firewallNative, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const firewall = new SipFirewall(loadFirewallConfig({ SIP_FIREWALL_MODE: 'shadow' }));
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
    const signaling = new SipbridgeSignaling(config);
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson(_url: string, body: { event?: string }) {
                return body?.event === 'invite' ? { action: 'answer', sdp } : {};
            }
        } as never,
        signaling,
        undefined,
        undefined,
        { firewall }
    );
    const peer = await sipPeer(fixture.sipPort, externalAddress);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const client = [...(signaling as any).peers.values()][0].client;
        const request = client.request.bind(client);
        let lost = false;
        // The 200 reaches sipbridge but its result is lost, so RTC fences the first-request context.
        client.request = async (payload: any, budget?: number) => {
            const result = await request(payload, budget);
            if (
                !lost &&
                payload.$case === 'command' &&
                payload.command.action?.$case === 'respond' &&
                payload.command.action.respond.status === 200
            ) {
                lost = true;
                throw new Error('simulated lost result');
            }
            return result;
        };
        peer.send('INVITE', 1, '', sdp);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
        const toTag = /^To:.*;tag=([^;\s]+)/im.exec(peer.messages.find(message => message.startsWith('SIP/2.0 200'))!)![1];
        peer.send('ACK', 1, toTag, '', 'z9hG4bK-' + randomUUID());
        const contexts = (signaling as any).contexts as Map<string, { expiresAt?: number }>;
        await until(() => [...contexts.values()].some(state => state.expiresAt !== undefined));
        for (const state of contexts.values()) if (state.expiresAt) state.expiresAt = Date.now() - 1;
        await until(() => contexts.size === 0, 5000);
        peer.messages.length = 0;
        // The re-INVITE targets an unrouted user: it must still be refused as a forgotten dialog, not scored as a route miss.
        rawInvite(peer, externalAddress!, fixture.sipPort, {
            user: 'unrouted',
            callId: peer.callId,
            fromTag: peer.tag,
            branch: 'z9hG4bK-' + randomUUID(),
            toTag,
            cseq: 2
        });
        await until(() => peer.messages.some(message => /^SIP\/2\.0 [2-6]\d\d/.test(message)), 8000);
        assert.match(
            peer.messages.find(message => /^SIP\/2\.0 [2-6]\d\d/.test(message))!,
            /^SIP\/2\.0 481/
        );
        assert.equal(firewall.counters.observations, 0);
    } catch (error) {
        console.error(fixture.logs, peer.messages);
        throw error;
    } finally {
        await gateway.shutdown();
        peer.close();
        await fixture.close();
    }
});

const offerSdp = sdp.replace('20000', '30000');
const answerSdp = sdp.replace('20000', '40000');

async function signalingFixture() {
    const fixture = await nativeFixture();
    const signaling = new SipbridgeSignaling(loadConfig(fixture.tls));
    await signaling.start();
    await until(() => signaling.isConnected);
    return { fixture, signaling };
}

test('native late-offer UAC: empty INVITE, 2xx offer, caller-supplied ACK answer', native, async () => {
    const { fixture, signaling } = await signalingFixture();
    const ua = await scriptedUa();
    try {
        const provisional: number[] = [];
        const attempt = signaling.openDialog({ requestUri: `sip:callee@127.0.0.1:${ua.port};transport=udp`, sdp: '' } as never);
        attempt.onProvisional = status => provisional.push(status);
        await until(() => ua.count('INVITE') === 1);
        const invite = ua.find('INVITE');
        assert.equal(invite.body, '');
        ua.reply(invite, 180, 'Ringing', offerSdp);
        ua.reply(invite, 200, 'OK', offerSdp);
        const dialog = await attempt.completed;
        assert.equal(dialog.remoteSdp, offerSdp);
        assert.equal(ua.count('ACK'), 0, 'native ACK is withheld until the application supplies the answer');
        assert.ok(dialog.localTag && dialog.remoteTag && dialog.sipCallId);
        await dialog.ackAnswer(answerSdp);
        await until(() => ua.count('ACK') === 1);
        assert.equal(ua.find('ACK').body, answerSdp);
        assert.match(ua.find('ACK').wire, /Content-Type: application\/sdp/i);
        assert.ok(provisional.includes(180));
        // Outbound (UAC) contexts have no observed peer source; callers fall back to the configured destination host.
        assert.equal(dialog.peerSource, undefined);
        await dialog.bye();
        await until(() => ua.count('BYE') === 1);
    } catch (error) {
        console.error(fixture.logs);
        console.error(ua.received.map(message => message.wire));
        throw error;
    } finally {
        ua.close();
        await signaling.stop();
        await fixture.close();
    }
});

test('native offerless re-INVITE we send returns the 2xx offer and takes the ACK answer', native, async () => {
    const { fixture, signaling } = await signalingFixture();
    const ua = await scriptedUa();
    try {
        const attempt = signaling.openDialog({ requestUri: `sip:callee@127.0.0.1:${ua.port};transport=udp`, sdp: offerSdp } as never);
        await until(() => ua.count('INVITE') === 1);
        ua.reply(ua.find('INVITE'), 200, 'OK', answerSdp);
        const dialog = await attempt.completed;
        await until(() => ua.count('ACK') === 1);
        const pending = dialog.reinvite('');
        await until(() => ua.count('INVITE') === 2);
        assert.equal(ua.find('INVITE', 1).body, '');
        ua.reply(ua.find('INVITE', 1), 200, 'OK', offerSdp);
        assert.equal(await pending, offerSdp);
        await dialog.ackAnswer(answerSdp);
        await until(() => ua.count('ACK') === 2);
        assert.equal(ua.find('ACK', 1).body, answerSdp);
        assert.equal(dialog.isFenced, false);
    } catch (error) {
        console.error(fixture.logs);
        console.error(ua.received.map(message => message.wire));
        throw error;
    } finally {
        ua.close();
        await signaling.stop();
        await fixture.close();
    }
});

test('native peer rejection of our re-INVITE rejects with the SIP status, without fencing the dialog', native, async () => {
    const { fixture, signaling } = await signalingFixture();
    const ua = await scriptedUa();
    try {
        const attempt = signaling.openDialog({ requestUri: `sip:callee@127.0.0.1:${ua.port};transport=udp`, sdp: offerSdp } as never);
        await until(() => ua.count('INVITE') === 1);
        ua.reply(ua.find('INVITE'), 200, 'OK', answerSdp);
        const dialog = await attempt.completed;
        await until(() => ua.count('ACK') === 1);
        for (const [index, status] of [488, 491, 481].entries()) {
            const pending = dialog.reinvite(offerSdp);
            await until(() => ua.count('INVITE') === index + 2);
            ua.reply(ua.find('INVITE', index + 1), status, 'Rejected');
            await assert.rejects(
                pending,
                (err: unknown) =>
                    err instanceof NativeOperationError &&
                    err.sipStatus === status &&
                    !err.uncertain &&
                    !err.unavailable &&
                    err.dialogGone === (status === 481)
            );
            assert.equal(dialog.isFenced, false);
            assert.equal(dialog.remoteSdp, answerSdp, 'a rejected re-INVITE leaves the remote SDP unchanged');
        }
        const bye = dialog.bye();
        await until(() => ua.count('BYE') === 1);
        ua.reply(ua.find('BYE'), 200, 'OK');
        await bye;
        assert.equal(dialog.isFenced, false);
    } catch (error) {
        console.error(fixture.logs);
        console.error(ua.received.map(message => message.wire));
        throw error;
    } finally {
        ua.close();
        await signaling.stop();
        await fixture.close();
    }
});

test('native local glare: our re-INVITE during a pending peer re-INVITE is refused with sipStatus 491', native, async () => {
    const { fixture, signaling } = await signalingFixture();
    try {
        const { peer, remoteTag, dialog } = await inboundDialog(fixture, signaling);
        const held = Promise.withResolvers<{ respond: (status: number) => Promise<unknown> }>();
        dialog.on('request', (_request, response) => held.resolve(response));
        peer.send('INVITE', 2, remoteTag, offerSdp, 'z9hG4bK-peer-reinvite');
        const response = await held.promise;
        await assert.rejects(
            dialog.reinvite(offerSdp),
            (err: unknown) => err instanceof NativeOperationError && err.sipStatus === 491 && !err.dialogGone && !err.uncertain && !err.unavailable
        );
        assert.equal(dialog.isFenced, false);
        await response.respond(488);
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 488')));
        peer.close();
    } catch (error) {
        console.error(fixture.logs);
        throw error;
    } finally {
        await signaling.stop();
        await fixture.close();
    }
});

test(
    'native unanswered re-INVITE through gateway.reinvite completes at the SIP timeout and ends the call',
    { ...native, timeout: 60000 },
    async () => {
        const fixture = await nativeFixture();
        const registry = new CallRegistry();
        const ua = await scriptedUa();
        const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
            async postJson() {
                return {};
            }
        } as never);
        try {
            await gateway.start();
            await until(() => gateway.isConnected);
            const created = gateway.createOutbound({
                requestUri: `sip:callee@127.0.0.1:${ua.port};transport=udp`,
                sdp: offerSdp,
                receiverUrl: 'https://owner.test/sip'
            });
            await until(() => ua.count('INVITE') === 1);
            ua.reply(ua.find('INVITE'), 200, 'OK', answerSdp);
            const call = await created;
            await until(() => ua.count('ACK') === 1);
            // The peer never answers: Timer B (~32s on UDP) completes the re-INVITE with no final status.
            await assert.rejects(gateway.reinvite(call.sessionId, offerSdp), (err: unknown) => err instanceof InvalidCallStateError);
            await until(() => ua.count('BYE') >= 1, 5000);
            assert.equal(registry.size, 0);
        } catch (error) {
            console.error(fixture.logs);
            console.error(ua.received.map(message => message.wire));
            throw error;
        } finally {
            await gateway.shutdown();
            ua.close();
            await fixture.close();
        }
    }
);

test('native gateway.reinvite maps a peer 488 to InvalidCallStateError and keeps the registry SDP', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const ua = await scriptedUa();
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const created = gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${ua.port};transport=udp`,
            sdp: offerSdp,
            receiverUrl: 'https://owner.test/sip'
        });
        await until(() => ua.count('INVITE') === 1);
        ua.reply(ua.find('INVITE'), 200, 'OK', answerSdp);
        const call = await created;
        await until(() => ua.count('ACK') === 1);
        const before = registry.get(call.sessionId)!.remoteSdp;
        const pending = gateway.reinvite(call.sessionId, offerSdp);
        await until(() => ua.count('INVITE') === 2);
        ua.reply(ua.find('INVITE', 1), 488, 'Not Acceptable Here', '');
        await assert.rejects(pending, (err: unknown) => err instanceof InvalidCallStateError);
        assert.equal(registry.get(call.sessionId)!.remoteSdp, before);
        assert.equal(registry.size, 1);
    } catch (error) {
        console.error(fixture.logs);
        console.error(ua.received.map(message => message.wire));
        throw error;
    } finally {
        await gateway.shutdown();
        ua.close();
        await fixture.close();
    }
});

test('native peer 481 to our re-INVITE through gateway.reinvite ends the call with a BYE', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const ua = await scriptedUa();
    const gateway = new SipGateway(loadConfig(fixture.tls), registry, {
        async postJson() {
            return {};
        }
    } as never);
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        const created = gateway.createOutbound({
            requestUri: `sip:callee@127.0.0.1:${ua.port};transport=udp`,
            sdp: offerSdp,
            receiverUrl: 'https://owner.test/sip'
        });
        await until(() => ua.count('INVITE') === 1);
        ua.reply(ua.find('INVITE'), 200, 'OK', answerSdp);
        const call = await created;
        await until(() => ua.count('ACK') === 1);
        const pending = gateway.reinvite(call.sessionId, offerSdp);
        await until(() => ua.count('INVITE') === 2);
        ua.reply(ua.find('INVITE', 1), 481, 'Call/Transaction Does Not Exist', '');
        await assert.rejects(pending, (err: unknown) => err instanceof InvalidCallStateError);
        await until(() => ua.count('BYE') === 1);
        ua.reply(ua.find('BYE'), 200, 'OK');
        await until(() => registry.size === 0);
    } catch (error) {
        console.error(fixture.logs);
        console.error(ua.received.map(message => message.wire));
        throw error;
    } finally {
        await gateway.shutdown();
        ua.close();
        await fixture.close();
    }
});

async function inboundDialog(fixture: Awaited<ReturnType<typeof nativeFixture>>, signaling: SipbridgeSignaling) {
    const peer = await sipPeer(fixture.sipPort);
    const dialogs: import('../src/sipbridge-signaling').NativeDialog[] = [];
    signaling.onInvite = async (_request, response) => {
        const dialog = await response.answer(sdp);
        dialog.activate();
        dialogs.push(dialog);
    };
    peer.send('INVITE', 1, '', offerSdp);
    await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
    const remoteTag = /^To:.*;tag=([^;\r\n]+)/im.exec(peer.messages.find(message => message.startsWith('SIP/2.0 200'))!)![1];
    peer.send('ACK', 1, remoteTag, '', 'z9hG4bK-ack');
    await until(() => dialogs.length === 1);
    return { peer, remoteTag, dialog: dialogs[0] };
}

test('native peer offerless re-INVITE: the ACK answer is delivered to the dialog with its CSeq', native, async () => {
    const { fixture, signaling } = await signalingFixture();
    try {
        const { peer, remoteTag, dialog } = await inboundDialog(fixture, signaling);
        const acks: { inviteCseq: number; body: string }[] = [];
        dialog.on('ack', ack => acks.push(ack));
        const waited = Promise.withResolvers<string>();
        dialog.on('request', async (request, response) => {
            const wait = dialog.awaitPeerAck(request.cseq, 5000);
            await response.respond(200, { body: offerSdp, headers: { 'Content-Type': 'application/sdp' } });
            wait.then(waited.resolve, waited.reject);
        });
        peer.send('INVITE', 2, remoteTag, '', 'z9hG4bK-reinvite');
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200') && /CSeq: 2 INVITE/i.test(message)));
        const ok = peer.messages.find(message => message.startsWith('SIP/2.0 200') && /CSeq: 2 INVITE/i.test(message))!;
        assert.ok(ok.endsWith(offerSdp));
        peer.send('ACK', 2, remoteTag, answerSdp, 'z9hG4bK-reinvite-ack');
        assert.equal(await waited.promise, answerSdp);
        assert.deepEqual(acks, [{ inviteCseq: 2, body: answerSdp }]);
        peer.close();
    } catch (error) {
        console.error(fixture.logs);
        throw error;
    } finally {
        await signaling.stop();
        await fixture.close();
    }
});

test('native REFER is presented to the dialog and answered 202 followed by an in-dialog NOTIFY; UPDATE is relayed', native, async () => {
    const { fixture, signaling } = await signalingFixture();
    try {
        const { peer, remoteTag, dialog } = await inboundDialog(fixture, signaling);
        peer.autoOk.add('NOTIFY').add('UPDATE');
        assert.equal(dialog.peerSource?.ip, '127.0.0.1');
        // Replaces orientation: to-tag is this gateway's tag, from-tag the peer's.
        assert.equal(dialog.localTag, remoteTag);
        assert.equal(dialog.remoteTag, peer.tag);
        assert.equal(dialog.sipCallId, peer.callId);
        assert.equal(dialog.peerSource?.port, peer.port);
        const seen: string[] = [];
        dialog.on('request', async (request, response) => {
            seen.push(request.method);
            if (request.method === 'REFER') {
                assert.match(request.get('refer-to') ?? '', /sip:target@example\.test/);
                await response.respond(202);
                await dialog.request('NOTIFY', {
                    headers: { Event: 'refer', 'Subscription-State': 'terminated;reason=noresource', 'Content-Type': 'message/sipfrag' },
                    body: 'SIP/2.0 200 OK\r\n'
                });
            } else if (request.method === 'UPDATE') {
                await response.respond(200, { body: answerSdp, headers: { 'Content-Type': 'application/sdp' } });
            }
        });
        peer.send('REFER', 2, remoteTag, '', 'z9hG4bK-refer', 'Refer-To: <sip:target@example.test>\r\n');
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 202')));
        await until(() => peer.messages.some(message => message.startsWith('NOTIFY ')));
        const notify = peer.messages.find(message => message.startsWith('NOTIFY '))!;
        assert.match(notify, /Event: refer/i);
        assert.match(notify, /Content-Type: message\/sipfrag/i);
        assert.ok(notify.endsWith('SIP/2.0 200 OK\r\n'));
        peer.send('UPDATE', 3, remoteTag, offerSdp, 'z9hG4bK-update');
        await until(() => peer.messages.some(message => message.startsWith('SIP/2.0 200') && /CSeq: 3 UPDATE/i.test(message)));
        assert.deepEqual(seen, ['REFER', 'UPDATE']);
        const ok = peer.messages.find(message => message.startsWith('SIP/2.0 200') && /CSeq: 3 UPDATE/i.test(message))!;
        assert.ok(ok.endsWith(answerSdp));
        await dialog.request('UPDATE', { body: offerSdp, headers: { 'Content-Type': 'application/sdp' } });
        await until(() => peer.messages.some(message => message.startsWith('UPDATE ')));
        peer.close();
    } catch (error) {
        console.error(fixture.logs);
        throw error;
    } finally {
        await signaling.stop();
        await fixture.close();
    }
});

test('native handoff: offerless destination, carrier cutover, paired BYE and a fully relayed offerless re-INVITE', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const log: string[] = [];
    const media = {
        assertHandoffMedia() {},
        async prepareHandoff() {
            log.push('stop-recording');
            return [];
        },
        releaseHandoff() {},
        async destroySession() {
            log.push('delete-media');
        }
    };
    const config = loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' });
    const gateway = new SipGateway(
        config,
        registry,
        {
            async postJson(_url: string, body: { event: string }) {
                return body.event === 'invite' ? { action: 'answer', sdp } : {};
            }
        } as never,
        undefined,
        undefined,
        undefined,
        { mediaController: media as never }
    );
    const carrier = await sipPeer(fixture.sipPort);
    const center = await scriptedUa();
    const answerOk = (wire: string, body: string) => {
        const get = (name: string) => new RegExp('^' + name + ':\\s*(.+)$', 'im').exec(wire)?.[1].trim() ?? '';
        carrier.socket.send(
            `SIP/2.0 200 OK\r\nVia: ${get('Via')}\r\nFrom: ${get('From')}\r\nTo: ${get('To')}\r\nCall-ID: ${get('Call-ID')}\r\nCSeq: ${get('CSeq')}\r\nContact: <sip:caller@127.0.0.1:${carrier.port};transport=udp>\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            fixture.sipPort,
            '127.0.0.1'
        );
    };
    const gatewayRequests = (method: string) => carrier.messages.filter(message => message.startsWith(method + ' '));
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        carrier.send('INVITE', 1, '', offerSdp);
        await until(() => carrier.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
        const remoteTag = /^To:.*;tag=([^;\r\n]+)/im.exec(carrier.messages.find(message => message.startsWith('SIP/2.0 200'))!)![1];
        carrier.send('ACK', 1, remoteTag, '', 'z9hG4bK-ack');
        await until(() => registry.size === 1);
        const call = registry.list()[0];

        const transfer = gateway.transfer(
            {
                sessionId: call.callId,
                mediaSessionId: 'media',
                transferId: 'transfer-1',
                requestUri: `sip:center@127.0.0.1:${center.port};transport=udp`
            },
            undefined
        );
        await until(() => center.count('INVITE') === 1);
        assert.equal(center.find('INVITE').body, '', 'the destination is dialed offerless');
        center.reply(center.find('INVITE'), 180, 'Ringing', offerSdp);
        center.reply(center.find('INVITE'), 200, 'OK', offerSdp.replace('30000', '45000'));
        await until(() => gatewayRequests('INVITE').length === 1);
        assert.deepEqual(log, ['stop-recording'], 'recording is stopped before the carrier sees destination SDP');
        assert.match(gatewayRequests('INVITE')[0], /m=audio 45000/);
        answerOk(gatewayRequests('INVITE')[0], answerSdp);
        const status = await transfer;
        assert.equal(status.state, 'completed');
        await until(() => center.count('ACK') === 1);
        assert.equal(center.find('ACK').body.includes('m=audio 40000'), true, 'the destination is ACKed with the carrier answer');
        await until(() => gatewayRequests('INVITE').length === 1 && log.includes('delete-media'));
        assert.equal(registry.list()[0].ownership, 'handed-off');

        // Offerless re-INVITE from the carrier: full relay through the destination leg.
        carrier.send('INVITE', 2, remoteTag, '', 'z9hG4bK-offerless');
        await until(() => center.count('INVITE') === 2);
        assert.equal(center.find('INVITE', 1).body, '');
        center.reply(center.find('INVITE', 1), 200, 'OK', offerSdp.replace('30000', '45002'));
        await until(() => carrier.messages.some(message => message.startsWith('SIP/2.0 200') && /CSeq: 2 INVITE/i.test(message)));
        const relayed = carrier.messages.find(message => message.startsWith('SIP/2.0 200') && /CSeq: 2 INVITE/i.test(message))!;
        assert.match(relayed, /m=audio 45002/);
        carrier.send('ACK', 2, remoteTag, answerSdp.replace('40000', '40002'), 'z9hG4bK-offerless-ack');
        await until(() => center.count('ACK') === 2);
        assert.match(center.find('ACK', 1).body, /m=audio 40002/);
        assert.equal(registry.size, 1);

        // Carrier BYE ends the destination leg exactly once.
        carrier.send('BYE', 3, remoteTag, '', 'z9hG4bK-bye');
        await until(() => center.count('BYE') === 1);
        center.reply(center.find('BYE'), 200, 'OK');
        await until(() => registry.size === 0);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(center.count('BYE'), 1);
    } catch (error) {
        console.error(fixture.logs);
        console.error(carrier.messages);
        console.error(center.received.map(message => message.wire));
        throw error;
    } finally {
        await gateway.shutdown();
        carrier.close();
        center.close();
        await fixture.close();
    }
});

test('native handoff: a BYE during an outstanding offerless re-INVITE reaches the peer after its owed ACK', native, async () => {
    const fixture = await nativeFixture();
    const registry = new CallRegistry();
    const media = {
        assertHandoffMedia() {},
        async prepareHandoff() {
            return [];
        },
        releaseHandoff() {},
        async destroySession() {}
    };
    const gateway = new SipGateway(
        loadConfig({ ...fixture.tls, ROUTES_JSON: '[{"match":"exact","value":"support","url":"https://owner.test/sip"}]' }),
        registry,
        {
            async postJson(_url: string, body: { event: string }) {
                return body.event === 'invite' ? { action: 'answer', sdp } : {};
            }
        } as never,
        undefined,
        undefined,
        undefined,
        { mediaController: media as never }
    );
    const carrier = await sipPeer(fixture.sipPort);
    const center = await scriptedUa();
    const answerOk = (wire: string, body: string) => {
        const get = (name: string) => new RegExp('^' + name + ':\\s*(.+)$', 'im').exec(wire)?.[1].trim() ?? '';
        carrier.socket.send(
            `SIP/2.0 200 OK\r\nVia: ${get('Via')}\r\nFrom: ${get('From')}\r\nTo: ${get('To')}\r\nCall-ID: ${get('Call-ID')}\r\nCSeq: ${get('CSeq')}\r\nContact: <sip:caller@127.0.0.1:${carrier.port};transport=udp>\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
            fixture.sipPort,
            '127.0.0.1'
        );
    };
    try {
        await gateway.start();
        await until(() => gateway.isConnected);
        carrier.send('INVITE', 1, '', offerSdp);
        await until(() => carrier.messages.some(message => message.startsWith('SIP/2.0 200')), 8000);
        const remoteTag = /^To:.*;tag=([^;\r\n]+)/im.exec(carrier.messages.find(message => message.startsWith('SIP/2.0 200'))!)![1];
        carrier.send('ACK', 1, remoteTag, '', 'z9hG4bK-ack');
        await until(() => registry.size === 1);
        const transfer = gateway.transfer(
            {
                sessionId: registry.list()[0].callId,
                mediaSessionId: 'media',
                transferId: 't1',
                requestUri: `sip:center@127.0.0.1:${center.port};transport=udp`
            },
            undefined
        );
        await until(() => center.count('INVITE') === 1);
        center.reply(center.find('INVITE'), 200, 'OK', offerSdp.replace('30000', '45000'));
        await until(() => carrier.messages.some(message => message.startsWith('INVITE ')));
        answerOk(
            carrier.messages.find(message => message.startsWith('INVITE '))!,
            answerSdp
        );
        await transfer;
        await until(() => center.count('ACK') === 1);

        carrier.send('INVITE', 2, remoteTag, '', 'z9hG4bK-offerless');
        await until(() => center.count('INVITE') === 2);
        // The peer has not answered yet; the carrier hangs up.
        carrier.send('BYE', 3, remoteTag, '', 'z9hG4bK-bye');
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.equal(center.count('BYE'), 0, 'no BYE while the offer is outstanding');
        center.reply(center.find('INVITE', 1), 200, 'OK', offerSdp.replace('30000', '45002'));
        await until(() => center.count('BYE') === 1);
        const methods = center.received.map(message => message.method);
        assert.ok(methods.lastIndexOf('ACK') > methods.indexOf('INVITE', 2) || methods.filter(m => m === 'ACK').length === 2);
        assert.ok(methods.lastIndexOf('ACK') < methods.indexOf('BYE'), 'wire order: ACK before BYE: ' + methods.join(','));
        center.reply(center.find('BYE'), 200, 'OK');
        await until(() => registry.size === 0);
    } catch (error) {
        console.error(fixture.logs);
        console.error(center.received.map(message => message.wire));
        throw error;
    } finally {
        await gateway.shutdown();
        carrier.close();
        center.close();
        await fixture.close();
    }
});
