import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareNativeCertificates, writeSignalingOnlyCatalog } from './support/native-fixtures.mjs';

mkdirSync('var', { recursive: true });
const fixtures = mkdtempSync(resolve('var/firewall-e2e-'));
const project = 'rtc-firewall-' + process.pid;
if (!process.env.SIPBRIDGE_IMAGE) throw new Error('SIPBRIDGE_IMAGE is required; use the runtime from dependencies/sipbridge-runtime.json');
const env = { ...process.env, FIREWALL_FIXTURES: fixtures };
const compose = args =>
    execFileSync('docker', ['compose', '-f', 'docker-compose.firewall.yml', '-p', project, ...args], {
        env,
        stdio: 'inherit'
    });
const exec = (service, code) =>
    execFileSync('docker', ['compose', '-f', 'docker-compose.firewall.yml', '-p', project, 'exec', '-T', service, 'node', '-e', code], {
        env,
        encoding: 'utf8'
    }).trim();
const api = (path, body, method = body ? 'POST' : 'GET') =>
    JSON.parse(
        exec(
            'gateway',
            `(async()=>{const r=await fetch('http://127.0.0.1:3001${path}',{method:${JSON.stringify(method)},headers:{authorization:'Bearer e2e-admin','content-type':'application/json'},body:${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'}});const body=await r.json();console.log(JSON.stringify({status:r.status,body}))})().catch(e=>{console.error(e.message);process.exit(1)})`
        )
    );
const snapshot = () =>
    JSON.parse(
        exec(
            'gateway',
            `(async()=>{const r=await fetch('http://127.0.0.1:3001/firewall/snapshot',{headers:{authorization:'Bearer e2e-reader'}});const b=await r.json();console.log(JSON.stringify(b))})()`
        )
    );
const receiver = () =>
    JSON.parse(
        exec(
            'gateway',
            `require('node:https').get('https://sipbridge:9098/v1/status',{ca:require('node:fs').readFileSync('/fixtures/native-ca.crt'),headers:{authorization:'Bearer e2e-publisher'}},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>console.log(body))}).on('error',e=>{console.error(e.message);process.exit(1)})`
        )
    );
const probe = (service = 'attacker', expect = '404', transport = 'udp', v6 = false) =>
    execFileSync(
        'docker',
        [
            'compose',
            '-f',
            'docker-compose.firewall.yml',
            '-p',
            project,
            'exec',
            '-T',
            '-e',
            'PROBE_EXPECT=' + expect,
            '-e',
            'PROBE_TRANSPORT=' + transport,
            '-e',
            'PROBE_V6=' + (v6 ? '1' : '0'),
            service,
            'node',
            'scripts/firewall-sip-probe.mjs'
        ],
        { env, stdio: 'inherit' }
    );
async function waitFor(predicate) {
    for (let i = 0; i < 40; i++) {
        try {
            if (predicate()) return;
        } catch {}
        await delay(250);
    }
    throw new Error('Firewall E2E convergence timeout');
}
async function waitApplied() {
    const desired = snapshot();
    await waitFor(() => {
        const status = receiver();
        return status.appliedInstanceId === desired.instanceId && status.appliedRevision === desired.revision && !status.lastError;
    });
}
try {
    chmodSync(fixtures, 0o755);
    prepareNativeCertificates(fixtures, { ip: '10.89.43.2', dns: ['sipbridge', 'sipbridge-e2e'] });
    // This runner blocks its event loop in synchronous docker calls, so a heartbeat cannot refresh the catalog.
    writeSignalingOnlyCatalog(fixtures + '/endpoints.json', { ip: '10.89.43.2', validMs: 60 * 60 * 1000 });
    compose(['up', '-d', '--build']);
    await waitFor(() => exec('gateway', `(async()=>{const r=await fetch('http://127.0.0.1:3001/readyz');console.log(r.status)})()`) === '200');
    console.log('Carrier allowlist preserves repeated IPv4 scans');
    for (let i = 0; i < 4; i++) probe('carrier');
    probe();
    probe();
    probe();
    await waitFor(() => snapshot().blocks.some(block => block.target === '10.89.43.30'));
    await waitApplied();
    probe('attacker', 'timeout');
    probe('attacker', 'timeout', 'tcp');
    probe('carrier');
    console.log('Adjacent IPv4 ranges retain independent bans when one is removed');
    api('/firewall/blocks', { target: '10.89.43.28/31', ttlSeconds: 60, reason: 'adjacent-e2e' });
    await waitApplied();
    assert.equal(receiver().active, 2);
    api('/firewall/blocks?target=10.89.43.28%2F31', undefined, 'DELETE');
    await waitApplied();
    assert.equal(receiver().active, 1);
    probe('attacker', 'timeout');
    assert.equal(api('/firewall/blocks?target=10.89.43.30', undefined, 'DELETE').status, 200);
    await waitApplied();
    probe('attacker', '404', 'tcp');
    console.log('IPv6 routing-only scans create an automatic kernel ban');
    probe('attacker', '404', 'udp', true);
    probe('attacker', '404', 'udp', true);
    probe('attacker', '404', 'udp', true);
    await waitApplied();
    probe('attacker', 'timeout', 'udp', true);
    probe('attacker', 'timeout', 'tcp', true);
    console.log('Adjacent IPv6 ranges retain independent bans when one is removed (the manual /127 sits outside the automatic /64)');
    api('/firewall/blocks', { target: 'fd42:7263:3::2e/127', ttlSeconds: 60, reason: 'adjacent-v6-e2e' });
    await waitApplied();
    assert.equal(receiver().active, 2);
    api('/firewall/blocks?target=fd42%3A7263%3A3%3A%3A2e%2F127', undefined, 'DELETE');
    await waitApplied();
    assert.equal(receiver().active, 1);
    probe('attacker', 'timeout', 'udp', true);
    api('/firewall/blocks?target=fd42%3A7263%3A2%3A%3A30', undefined, 'DELETE');
    await waitApplied();
    console.log('Manual IPv6 ban is enforced and carrier-overlapping CIDR is refused');
    assert.equal(api('/firewall/blocks', { target: 'fd42:7263:2::30', ttlSeconds: 30, reason: 'v6-e2e' }).status, 200);
    await waitApplied();
    probe('attacker', 'timeout', 'udp', true);
    probe('attacker', 'timeout', 'tcp', true);
    assert.equal(
        api('/firewall/blocks', {
            target: '10.89.43.0/24',
            ttlSeconds: 30,
            reason: 'must refuse carrier overlap'
        }).status,
        400
    );
    api('/firewall/blocks?target=fd42%3A7263%3A2%3A%3A30', undefined, 'DELETE');
    console.log('Changed timeout is recreated and kernel expiry survives a stopped sidecar');
    api('/firewall/blocks', { target: '10.89.43.30', ttlSeconds: 30, reason: 'refresh-e2e' });
    await waitApplied();
    assert.equal(api('/firewall/blocks', { target: '10.89.43.30', ttlSeconds: 6, reason: 'expiry-e2e' }).status, 200);
    await waitApplied();
    probe('attacker', 'timeout');
    compose(['stop', 'firewall']);
    await delay(6500);
    probe('attacker', '404', 'tcp');
    compose(['start', 'firewall']);
    await waitApplied();
    console.log('Sidecar restart removes stale kernel state after a missed unblock');
    api('/firewall/blocks', { target: '10.89.43.30', ttlSeconds: 30, reason: 'restart-e2e' });
    await waitApplied();
    probe('attacker', 'timeout');
    compose(['stop', 'firewall']);
    api('/firewall/blocks?target=10.89.43.30', undefined, 'DELETE');
    compose(['start', 'firewall']);
    await waitApplied();
    probe('attacker', '404', 'tcp');
    console.log('Gateway restart resets learned state and replaces the old owner');
    api('/firewall/blocks', { target: '10.89.43.30', ttlSeconds: 30, reason: 'owner-e2e' });
    await waitApplied();
    probe('attacker', 'timeout');
    compose(['restart', 'gateway']);
    await waitFor(() => snapshot().blocks.length === 0);
    await waitApplied();
    probe('attacker', '404', 'tcp');
    console.log('sipbridge namespace replacement rebuilds the current finite ban');
    api('/firewall/blocks', { target: '10.89.43.30', ttlSeconds: 120, reason: 'namespace-e2e' });
    await waitApplied();
    compose(['up', '-d', '--force-recreate', 'sipbridge', 'firewall']);
    await waitFor(() => exec('gateway', `(async()=>{const r=await fetch('http://127.0.0.1:3001/readyz');console.log(r.status)})()`) === '200');
    await waitApplied();
    probe('carrier');
    probe('attacker', 'timeout');
    probe('attacker', 'timeout', 'tcp');
    console.log('Real firewall packet checks passed');
} catch (error) {
    try {
        console.error('Receiver state:', receiver());
    } catch {}
    compose(['logs', '--no-color', '--tail=80', 'gateway', 'firewall', 'sipbridge']);
    throw error;
} finally {
    compose(['down', '-v', '--remove-orphans']);
    rmSync(fixtures, { recursive: true, force: true });
}
