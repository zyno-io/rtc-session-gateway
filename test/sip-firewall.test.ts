import assert from 'node:assert/strict';
import test from 'node:test';
import { addressRange, overlaps, sourceIp } from '../src/firewall-address';
import { FIREWALL_MAX_TTL_MS, parseFirewallSnapshot } from '../src/firewall-contract';
import { loadFirewallConfig, SipFirewall } from '../src/sip-firewall';

const start = Date.parse('2026-10-06T00:00:00.000Z');
const config = (overrides = {}) => ({
    ...loadFirewallConfig({ SIP_FIREWALL_MODE: 'enforce' }),
    ...overrides
});

test('address canonicalization covers IPv4, IPv6, mapped IPv6, and CIDR overlap', () => {
    assert.equal(addressRange('192.0.2.97/24').target, '192.0.2.0/24');
    assert.equal(addressRange('2001:DB8::2/64').target, '2001:db8:0:0:0:0:0:0/64');
    assert.equal(sourceIp('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(sourceIp('::ffff:c000:0201'), '192.0.2.1');
    assert.equal(addressRange('::ffff:192.0.2.99/120').target, '192.0.2.0/24');
    assert.ok(overlaps(addressRange('192.0.2.0/24'), addressRange('192.0.2.1')));
    assert.ok(overlaps(addressRange('2001:db8::/32'), addressRange('2001:db8:1::/64')));
    for (const invalid of ['1.2.3.4;id', 'host.example', '1.2.3.4:5060', '192.0.2.1/33', '2001:db8::/129', '1.2.3.4/-1', '1.2.3.4/24/2', ' 1.2.3.4'])
        assert.throws(() => addressRange(invalid));
    assert.equal(sourceIp('192.0.2.0/24'), undefined);
});

test('weighted scores decay and reach threshold without refreshing an existing ban', () => {
    let now = start;
    const firewall = new SipFirewall(config({ threshold: 2 }), () => now);
    firewall.observe('192.0.2.1', 'scan', 'no-route');
    now += firewall.config.halfLifeMs;
    firewall.observe('192.0.2.1', 'scan', 'no-route');
    assert.equal(firewall.shouldReject('192.0.2.1'), false);
    firewall.observe('192.0.2.1', 'scan', 'no-route');
    const before = firewall.snapshot();
    assert.equal(firewall.shouldReject('::ffff:192.0.2.1'), true);
    now += 1000;
    firewall.observe('192.0.2.1', 'scan', 'no-route');
    assert.deepEqual(firewall.snapshot().blocks, before.blocks);
    assert.equal(firewall.status().counters.bans, 1);
});

test('number discounts, suspicious prefixes, dedupe, and each escalation tier', () => {
    let now = start;
    const firewall = new SipFirewall(config({ threshold: 1, banTtlsSec: [1, 2, 3, 4] }), () => now);
    firewall.observe('192.0.2.1', '15551234567', 'no-route', 'same-transaction');
    firewall.observe('192.0.2.1', '15551234567', 'no-route', 'same-transaction');
    assert.equal(firewall.status().counters.observations, 1);
    assert.equal(firewall.shouldReject('192.0.2.1'), false);
    firewall.observe('192.0.2.2', '011123456', 'no-route');
    assert.equal(firewall.shouldReject('192.0.2.2'), true);
    for (const ttl of [1, 2, 3, 4, 4]) {
        firewall.observe('192.0.2.3', 'scan', 'no-route');
        assert.equal(firewall.blocks().find(block => block.target === '192.0.2.3')?.expiresAt, now + ttl * 1000);
        now += ttl * 1000;
        assert.equal(firewall.shouldReject('192.0.2.3'), false);
    }
    now += FIREWALL_MAX_TTL_MS + 1;
    firewall.observe('192.0.2.3', 'scan', 'no-route');
    assert.equal(firewall.blocks().find(block => block.target === '192.0.2.3')?.expiresAt, now + 1000);
});

test('allowlist wins over broader manual CIDRs and handles both address families', () => {
    const firewall = new SipFirewall(config({ threshold: 1, allowlist: ['192.0.2.1', '2001:db8::/32'] }), () => start);
    firewall.observe('::ffff:192.0.2.1', 'scan', 'no-route');
    firewall.observe('2001:db8::42', 'scan', 'no-route');
    assert.equal(firewall.status().records, 0);
    assert.throws(() => firewall.ban('192.0.2.0/24', 60, 'overlap'));
    assert.throws(() => firewall.ban('2001:db8:1::/64', 60, 'overlap'));
});

test('manual/automatic precedence, expiry, exact unblock and runtime reset', () => {
    let now = start;
    const firewall = new SipFirewall(config({ threshold: 1, banTtlsSec: [1] }), () => now);
    firewall.observe('192.0.2.1', 'scan', 'no-route');
    firewall.ban('192.0.2.1', 5, 'manual');
    assert.equal(firewall.snapshot().blocks.length, 1);
    assert.equal(firewall.snapshot().blocks[0].expiresAt, new Date(start + 5000).toISOString());
    now += 1000;
    assert.equal(firewall.shouldReject('192.0.2.1'), true);
    firewall.unblock('::ffff:192.0.2.1');
    assert.equal(firewall.shouldReject('192.0.2.1'), false);
    firewall.ban('192.0.2.0/24', 1, 'range');
    assert.equal(firewall.shouldReject('192.0.2.98'), true);
    now += 1000;
    assert.equal(firewall.shouldReject('192.0.2.98'), false);
    assert.equal(firewall.snapshot().blocks.length, 0);
    assert.equal(new SipFirewall(config(), () => now).snapshot().blocks.length, 0);
    assert.throws(() => firewall.ban('192.0.2.1', Infinity, 'bad'));
    assert.throws(() => firewall.ban('192.0.2.1', 604801, 'bad'));
});

test('shadow/off modes cannot enforce or accept manual bans', () => {
    for (const mode of ['shadow', 'off'] as const) {
        const firewall = new SipFirewall(config({ mode, threshold: 1 }), () => start);
        firewall.observe('192.0.2.1', 'scan', 'no-route');
        assert.equal(firewall.shouldReject('192.0.2.1'), false);
        assert.equal(firewall.snapshot().blocks.length, 0);
        assert.throws(() => firewall.ban('192.0.2.1', 1, 'manual'));
        assert.equal(firewall.counters.wouldBan, mode === 'shadow' ? 1 : 0);
    }
});

test('capacity keeps live bans and bounded sweeping frees inactive scores and markers', () => {
    let now = start;
    const firewall = new SipFirewall(config({ maxRecords: 2, maxBlocks: 1, threshold: 1, banTtlsSec: [1], halfLifeMs: 10 }), () => now);
    firewall.observe('192.0.2.1', 'scan', 'no-route', 'a');
    firewall.observe('192.0.2.2', 'scan', 'no-route', 'b');
    firewall.observe('192.0.2.3', 'scan', 'no-route', 'c');
    assert.equal(firewall.blocks().length, 1);
    assert.equal(firewall.shouldReject('192.0.2.1'), true);
    assert.ok(firewall.counters.skipped >= 2);
    now += FIREWALL_MAX_TTL_MS + 1;
    firewall.sweep(10);
    assert.equal(firewall.status().records, 0);
    firewall.observe('192.0.2.3', 'scan', 'no-route', 'c');
    assert.equal(firewall.shouldReject('192.0.2.3'), true);
});

test('configuration and public snapshot reject invalid/unbounded state', () => {
    for (const env of [
        { SIP_FIREWALL_MODE: 'bad' },
        { SIP_FIREWALL_THRESHOLD: '0' },
        { SIP_FIREWALL_MAX_BLOCKS: '10001' },
        { SIP_FIREWALL_BAN_TTLS_SEC: '60,1' },
        { SIP_FIREWALL_ALLOWLIST_JSON: '["bad"]' },
        { SIP_FIREWALL_PUBLISHER_URL: 'http://192.0.2.1/v1/snapshot' }
    ])
        assert.throws(() => loadFirewallConfig(env));
    const snapshot = new SipFirewall(config(), () => start).snapshot();
    assert.deepEqual(parseFirewallSnapshot(snapshot, start), snapshot);
    assert.throws(() => parseFirewallSnapshot({ ...snapshot, revision: -1 }, start));
    assert.throws(() => parseFirewallSnapshot({ ...snapshot, allowlist: ['192.0.2.1', '::ffff:192.0.2.1'] }, start));
    assert.throws(() => parseFirewallSnapshot(snapshot, start + 60_001));
});

test('direct SIP observations decode percent-escaped dial targets before weighting and tolerate malformed escapes', () => {
    const firewall = new SipFirewall(config({ threshold: 1 }), () => start);
    for (let i = 0; i < 3; i++) firewall.observe('192.0.2.10', '%2B15551234567', 'no-route', String(i));
    assert.equal(firewall.shouldReject('192.0.2.10'), false);
    firewall.observe('192.0.2.10', '%2B15551234567', 'no-route', 'fourth');
    assert.equal(firewall.shouldReject('192.0.2.10'), true);
    assert.doesNotThrow(() => firewall.observe('192.0.2.11', '%ZZ', 'no-route'));
    assert.equal(firewall.shouldReject('192.0.2.11'), true);
    const international = new SipFirewall(config({ threshold: 2 }), () => start);
    international.observe('192.0.2.12', '%30%31%311234567', 'no-route');
    assert.equal(international.shouldReject('192.0.2.12'), true);
});

test('unknown-Replaces observations are ignored unless explicitly enabled', () => {
    const off = new SipFirewall(config({ threshold: 1 }), () => start);
    off.observe('192.0.2.1', 'scan', 'unknown-replaces', 'r', true);
    assert.equal(off.counters.observations, 0);
    const on = new SipFirewall(config({ threshold: 1, observeUnknownReplaces: true }), () => start);
    on.observe('192.0.2.1', 'scan', 'unknown-replaces', 'r', true);
    assert.equal(on.counters.observations, 1);
});

test('bans reject /0, overly broad and loopback-overlapping targets; allowlists may stay broad', () => {
    const firewall = new SipFirewall(config(), () => start);
    for (const target of ['0.0.0.0/0', '::ffff:0:0/96', '::/0', '128.0.0.0/7', '8000::/15'])
        assert.throws(() => firewall.ban(target, 60, 'broad'), /too broad/);
    for (const target of ['127.0.0.1', '127.0.0.0/8', '::1', '::ffff:127.0.0.1', '::/16'])
        assert.throws(() => firewall.ban(target, 60, 'loopback'), /loopback/);
    assert.doesNotThrow(() => firewall.ban('192.0.0.0/8', 60, 'ok'));
    assert.doesNotThrow(() => firewall.ban('2001::/16', 60, 'ok'));
    assert.doesNotThrow(() => new SipFirewall(config({ allowlist: ['0.0.0.0/0'] }), () => start));
});

test('loopback sources are never scored or banned automatically', () => {
    const firewall = new SipFirewall(config({ threshold: 1 }), () => start);
    firewall.observe('127.0.0.1', 'scan', 'no-route');
    firewall.observe('::1', 'scan', 'no-route');
    assert.equal(firewall.status().records, 0);
    assert.equal(firewall.blocks().length, 0);
});

test('IPv6 sources are scored and auto-banned per /64; IPv4 stays per host', () => {
    const firewall = new SipFirewall(config({ threshold: 3 }), () => start);
    firewall.observe('2001:db8:1:2::1', 'scan', 'no-route');
    firewall.observe('2001:db8:1:2:aaaa::2', 'scan', 'no-route');
    assert.equal(firewall.status().records, 1);
    assert.equal(firewall.shouldReject('2001:db8:1:2::3'), false);
    firewall.observe('2001:db8:1:2:ffff:ffff:ffff:ffff', 'scan', 'no-route');
    assert.deepEqual(
        firewall.blocks().map(block => block.target),
        ['2001:db8:1:2:0:0:0:0/64']
    );
    assert.equal(firewall.shouldReject('2001:db8:1:2:1234::9'), true);
    assert.equal(firewall.shouldReject('2001:db8:1:3::1'), false);
    assert.equal(firewall.snapshot().blocks[0].target, '2001:db8:1:2:0:0:0:0/64');
    firewall.unblock('2001:db8:1:2::77');
    assert.equal(firewall.shouldReject('2001:db8:1:2::1'), false);
    const v4 = new SipFirewall(config({ threshold: 2 }), () => start);
    v4.observe('192.0.2.1', 'scan', 'no-route');
    v4.observe('192.0.2.2', 'scan', 'no-route');
    assert.equal(v4.status().records, 2);
});

test('manual bans do not leak parsed ranges into serialized output and still match', () => {
    const firewall = new SipFirewall(config(), () => start);
    firewall.ban('192.0.2.0/24', 60, 'range');
    assert.equal(firewall.shouldReject('192.0.2.50'), true);
    assert.doesNotThrow(() => JSON.stringify(firewall.blocks()));
    assert.doesNotThrow(() => JSON.stringify(firewall.snapshot()));
    assert.deepEqual(Object.keys(firewall.blocks()[0]).sort(), ['expiresAt', 'kind', 'reason', 'target']);
});
