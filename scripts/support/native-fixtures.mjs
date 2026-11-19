import { execFileSync } from 'node:child_process';
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

/** Spiffe identity the gateway presents to sipbridge; sipbridge must be started with the same --allowed-client-uri. */
export const CONTROLLER_URI = 'spiffe://rtc/e2e/controller';

/**
 * Writes a throwaway CA plus server/client certificates for the sipbridge control and SIP TLS listeners
 * into `directory`. Public test identities only; they expire after two days.
 */
export function prepareNativeCertificates(directory, { ip, dns = ['sipbridge-e2e'] }) {
    const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
    openssl([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'native-ca.key',
        '-out',
        'native-ca.crt',
        '-days',
        '2',
        '-subj',
        '/CN=RTC native E2E CA'
    ]);
    for (const kind of ['server', 'client']) {
        openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `native-${kind}.key`, '-out', `native-${kind}.csr`, '-subj', '/CN=RTC E2E']);
        writeFileSync(
            `${directory}/native-${kind}.ext`,
            kind === 'server'
                ? `subjectAltName=${[...dns.map(name => 'DNS:' + name), 'IP:' + ip].join(',')}\nextendedKeyUsage=serverAuth\n`
                : `subjectAltName=URI:${CONTROLLER_URI}\nextendedKeyUsage=clientAuth\n`
        );
        openssl([
            'x509',
            '-req',
            '-in',
            `native-${kind}.csr`,
            '-CA',
            'native-ca.crt',
            '-CAkey',
            'native-ca.key',
            '-CAcreateserial',
            '-out',
            `native-${kind}.crt`,
            '-days',
            '2',
            '-extfile',
            `native-${kind}.ext`
        ]);
        chmodSync(`${directory}/native-${kind}.key`, 0o644);
        chmodSync(`${directory}/native-${kind}.crt`, 0o644);
    }
    chmodSync(`${directory}/native-ca.crt`, 0o644);
}

/** Signaling section of the endpoint catalog for one sipbridge; the catalog is only valid for 30 seconds. */
export function signalingCatalogSection({ id = 'sipbridge-e2e', ip, serverName = 'sipbridge-e2e', validMs = 30000 }) {
    return {
        revision: 'a'.repeat(64),
        validUntil: new Date(Date.now() + validMs).toISOString(),
        backends: [{ id, acceptNew: true, control: { url: `wss://${ip}:8443/v1/control`, tlsServerName: serverName } }]
    };
}

export function writeCatalogFile(target, catalog) {
    writeFileSync(`${target}.tmp`, JSON.stringify(catalog), { mode: 0o644 });
    chmodSync(`${target}.tmp`, 0o644);
    renameSync(`${target}.tmp`, target);
}

/**
 * A catalog with only a signaling backend (the empty media section is valid and withdraws nothing).
 * `validMs` defaults to 30 seconds; runners that block their event loop should pass a longer validity.
 */
export function writeSignalingOnlyCatalog(target, options) {
    writeCatalogFile(target, {
        schemaVersion: 2,
        signaling: signalingCatalogSection(options),
        media: { revision: 'b'.repeat(64), validUntil: new Date(Date.now() + (options.validMs ?? 30000)).toISOString(), backends: [] }
    });
}
