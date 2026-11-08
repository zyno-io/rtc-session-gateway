import assert from 'node:assert/strict';
import { test } from 'node:test';
const native = {
    timeout: 20000,
    skip: process.env.SIPBRIDGE_TEST_BINARY ? false : 'Run yarn test:native with the pinned native runtime'
};
import { loadConfig } from '../src/config';
import { SipGateway } from '../src/sip-gateway';
import { CallRegistry } from '../src/call-registry';
import { nativeFixture, sipPeer, until } from './support/native-fixture';

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
        assert.ok(uas.messages.some(wire => wire.startsWith('BYE ')));
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

test('duplicate ingress runs policy once and native CANCEL wins while owner decision is pending', native, async () => {
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

test('native session reconnect keeps the original authority and retained dialog without replay', native, async () => {
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
        assert.equal(registry.size, 1);
        assert.equal(uas.messages.filter(wire => wire.startsWith('INVITE ')).length, 1);
        await gateway.reinvite(call.sessionId, sdp);
        await gateway.bye(call.sessionId);
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
