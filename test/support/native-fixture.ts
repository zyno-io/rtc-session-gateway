import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';

export async function freePort() {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}
export async function until(test: () => boolean | Promise<boolean>, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!(await test())) {
        if (Date.now() >= deadline) throw new Error('Condition timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
export async function nativeFixture() {
    const directory = mkdtempSync(join(tmpdir(), 'rtc-native-'));
    function openssl(args: string[]) {
        execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
    }
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=RTC Test CA']);
    for (const kind of ['server', 'client']) {
        openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', kind + '.key', '-out', kind + '.csr', '-subj', '/CN=' + kind]);
        writeFileSync(
            join(directory, kind + '.ext'),
            kind === 'server'
                ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
                : 'subjectAltName=URI:spiffe://rtc/test\nextendedKeyUsage=clientAuth\n'
        );
        openssl([
            'x509',
            '-req',
            '-in',
            kind + '.csr',
            '-CA',
            'ca.crt',
            '-CAkey',
            'ca.key',
            '-CAcreateserial',
            '-out',
            kind + '.crt',
            '-days',
            '1',
            '-extfile',
            kind + '.ext'
        ]);
    }
    const [sipPort, tlsPort, controlPort, adminPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const start = () =>
        spawn(
            process.env.SIPBRIDGE_TEST_BINARY!,
            [
                '--instance',
                'sipbridge-test',
                '--control-listen',
                '127.0.0.1:' + controlPort,
                '--admin-listen',
                '127.0.0.1:' + adminPort,
                '--sip-listen',
                '127.0.0.1:' + tlsPort,
                '--sip-plain-listen',
                '127.0.0.1:' + sipPort,
                '--advertise',
                '127.0.0.1:' + tlsPort,
                '--advertise-plain',
                '127.0.0.1:' + sipPort,
                '--control-cert',
                join(directory, 'server.crt'),
                '--control-key',
                join(directory, 'server.key'),
                '--sip-cert',
                join(directory, 'server.crt'),
                '--sip-key',
                join(directory, 'server.key'),
                '--client-ca',
                join(directory, 'ca.crt'),
                '--allowed-client-uri',
                'spiffe://rtc/test',
                '--require-auth-methods',
                '',
                '--allow-register=false',
                '--allow-subscribe=false'
            ],
            {
                env: { ...process.env, SIPBRIDGE_STATE_BACKEND: 'memory' },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
    let child = start();
    let logs = '';
    const capture = () => {
        child.stdout?.on('data', data => {
            logs = (logs + data).slice(-16000);
        });
        child.stderr?.on('data', data => {
            logs = (logs + data).slice(-16000);
        });
    };
    capture();
    await until(async () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native fixture stopped: ' + logs);
        try {
            return (await fetch('http://127.0.0.1:' + adminPort + '/healthz')).ok;
        } catch {
            return false;
        }
    });
    const catalogFile = join(directory, 'endpoints.json');
    function publish(acceptNew = true, mediaUntil = Date.now() + 30000, signalingUntil = Date.now() + 30000) {
        writeFileSync(
            catalogFile,
            JSON.stringify({
                schemaVersion: 2,
                signaling: {
                    revision: 'a'.repeat(64),
                    validUntil: new Date(signalingUntil).toISOString(),
                    backends: [
                        {
                            id: 'sipbridge-test',
                            acceptNew,
                            control: {
                                url: 'wss://127.0.0.1:' + controlPort + '/v1/control',
                                tlsServerName: 'localhost'
                            }
                        }
                    ]
                },
                media: {
                    revision: 'b'.repeat(64),
                    validUntil: new Date(mediaUntil).toISOString(),
                    backends: []
                }
            })
        );
    }
    publish();
    return {
        directory,
        catalogFile,
        sipPort,
        tlsPort,
        controlPort,
        adminPort,
        publish,
        get child() {
            return child;
        },
        get logs() {
            return logs;
        },
        tls: {
            RTC_ENDPOINTS_FILE: catalogFile,
            SIPBRIDGE_TLS_CERT_FILE: join(directory, 'client.crt'),
            SIPBRIDGE_TLS_KEY_FILE: join(directory, 'client.key'),
            SIPBRIDGE_TLS_CA_FILE: join(directory, 'ca.crt')
        },
        async restart() {
            child.kill('SIGKILL');
            await until(() => child.exitCode !== null || child.signalCode !== null);
            child = start();
            capture();
            await until(async () => {
                try {
                    return (await fetch('http://127.0.0.1:' + adminPort + '/healthz')).ok;
                } catch {
                    return false;
                }
            });
        },
        async close() {
            child.kill('SIGTERM');
            await until(() => child.exitCode !== null || child.signalCode !== null, 5000).catch(() => {
                child.kill('SIGKILL');
            });
            rmSync(directory, { recursive: true, force: true });
        }
    };
}
export async function sipPeer(sipPort: number) {
    const socket = createSocket('udp4');
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    const callId = randomUUID() + '@rtc.test';
    const tag = randomUUID();
    const branch = 'z9hG4bK-' + randomUUID();
    const messages: string[] = [];
    socket.on('message', bytes => {
        messages.push(bytes.toString());
    });
    function send(method: string, cseq = 1, toTag = '', sdp = '', viaBranch = branch) {
        const body = sdp;
        const wire = `${method} sip:support@localhost SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:${port};branch=${viaBranch};rport\r\nMax-Forwards: 70\r\nFrom: <sip:caller@localhost>;tag=${tag}\r\nTo: <sip:support@localhost>${toTag ? ';tag=' + toTag : ''}\r\nCall-ID: ${callId}\r\nCSeq: ${cseq} ${method}\r\nContact: <sip:caller@127.0.0.1:${port};transport=udp>\r\n${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        socket.send(wire, sipPort, '127.0.0.1');
    }
    return {
        socket,
        messages,
        send,
        callId,
        port,
        close() {
            socket.close();
        }
    };
}
export async function udpUas(answerSdp: string, answer = true, auth?: { username: string; password: string }) {
    const socket = createSocket('udp4');
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    const messages: string[] = [];
    let initial: { wire: string; port: number; address: string } | undefined;
    function respond(wire: string, remote: { port: number; address: string }, status: number, reason: string, body = '', extra = '') {
        const get = (name: string) => new RegExp('^' + name + ':\\s*(.+)$', 'im').exec(wire)?.[1].trim() ?? '';
        const to = get('To');
        const bytes = `SIP/2.0 ${status} ${reason}\r\nVia: ${get('Via')}\r\nFrom: ${get('From')}\r\nTo: ${to}${to.includes(';tag=') ? '' : ';tag=uas-tag'}\r\nCall-ID: ${get('Call-ID')}\r\nCSeq: ${get('CSeq')}\r\nContact: <sip:uas@127.0.0.1:${port};transport=udp>\r\n${extra}${body ? 'Content-Type: application/sdp\r\n' : ''}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        socket.send(bytes, remote.port, remote.address);
    }
    socket.on('message', (bytes, remote) => {
        const wire = bytes.toString();
        messages.push(wire);
        const method = wire.split(' ')[0];
        if (method === 'INVITE') {
            if (auth) {
                const authorization = /^Authorization:\s*Digest (.+)$/im.exec(wire)?.[1];
                if (!authorization) {
                    respond(
                        wire,
                        remote,
                        401,
                        'Unauthorized',
                        '',
                        'WWW-Authenticate: Digest realm="rtc-test", nonce="fixture-nonce", algorithm=MD5, qop="auth"\r\n'
                    );
                    return;
                }
                const values = Object.fromEntries(
                    [...authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(match => [match[1], match[2] ?? match[3]])
                );
                const md5 = (value: string) => createHash('md5').update(value).digest('hex');
                const ha1 = md5(`${auth.username}:rtc-test:${auth.password}`);
                const ha2 = md5(`INVITE:${wire.split(' ')[1]}`);
                const expected = md5(`${ha1}:fixture-nonce:${values.nc}:${values.cnonce}:auth:${ha2}`);
                if (
                    values.username !== auth.username ||
                    values.realm !== 'rtc-test' ||
                    values.nonce !== 'fixture-nonce' ||
                    values.qop !== 'auth' ||
                    values.uri !== wire.split(' ')[1] ||
                    values.response !== expected
                ) {
                    respond(wire, remote, 403, 'Forbidden');
                    return;
                }
            }
            initial = { wire, ...remote };
            respond(wire, remote, 180, 'Ringing');
            if (answer) respond(wire, remote, 200, 'OK', answerSdp);
        } else if (method === 'CANCEL') {
            respond(wire, remote, 200, 'OK');
            if (initial) respond(initial.wire, initial, 487, 'Request Terminated');
        } else if (method === 'BYE') respond(wire, remote, 200, 'OK');
    });
    return {
        port,
        messages,
        close() {
            socket.close();
        }
    };
}
