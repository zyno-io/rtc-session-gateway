import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createFirewallHandler } from '../../src/firewall-receiver';
import { FirewallReconciler } from '../../src/firewall-reconciler';
import { BaseLogger } from '../../src/logger';
import { NftablesFirewallBackend } from './nftables-backend';

async function main(): Promise<void> {
    const logger = BaseLogger.child({ ns: 'FirewallSidecar' });
    const host = process.env.SIP_FIREWALL_LISTEN_HOST ?? '127.0.0.1';
    const port = Number(process.env.SIP_FIREWALL_LISTEN_PORT ?? 9098);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SIP_FIREWALL_LISTEN_PORT');
    const token = process.env.SIP_FIREWALL_RECEIVER_TOKEN_FILE
        ? readFileSync(process.env.SIP_FIREWALL_RECEIVER_TOKEN_FILE, 'utf8').trim()
        : process.env.SIP_FIREWALL_RECEIVER_TOKEN;
    if (!token) throw new Error('Firewall receiver token required');
    const certFile = process.env.SIP_FIREWALL_TLS_CERT_FILE;
    const keyFile = process.env.SIP_FIREWALL_TLS_KEY_FILE;
    if (!!certFile !== !!keyFile || (!['127.0.0.1', '::1'].includes(host) && !certFile))
        throw new Error('Non-loopback firewall listener requires TLS certificate and key');
    const reconciler = new FirewallReconciler(new NftablesFirewallBackend(process.env.SIP_FIREWALL_TABLE ?? 'rtc_sipguard'));
    const handler = createFirewallHandler(reconciler, token);
    const server =
        certFile && keyFile
            ? https.createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile), minVersion: 'TLSv1.3' }, handler)
            : http.createServer(handler);
    server.requestTimeout = 2000;
    server.headersTimeout = 2000;
    const timer = setInterval(() => {
        if (reconciler.state.lastError) logger.warn('Firewall reconciliation failed');
        reconciler.schedule();
    }, 30_000);
    server.listen(port, host, () => logger.info({ host, port }, 'Firewall receiver listening'));
    for (const signal of ['SIGTERM', 'SIGINT'])
        process.once(signal, () => {
            clearInterval(timer);
            server.close();
            server.closeAllConnections();
            // Keep installed finite kernel bans; they expire independently of this process.
        });
}

if (require.main === module)
    void main().catch(() => {
        console.error('Firewall sidecar startup failed');
        process.exitCode = 1;
    });
