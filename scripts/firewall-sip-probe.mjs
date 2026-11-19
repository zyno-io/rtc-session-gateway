import dgram from 'node:dgram';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const host = process.env.PROBE_V6 === '1' ? 'fd42:7263:2::2' : '10.89.43.2';
const transport = process.env.PROBE_TRANSPORT ?? 'udp';
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 1200);
const expect = process.env.PROBE_EXPECT ?? '404';
const id = randomUUID();
let socket;
let result = 'timeout';
let finished = false;
const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (transport === 'udp') socket.close();
    else socket.destroy();
    if (result !== expect) {
        console.error('Expected', expect, 'received', result);
        process.exitCode = 1;
    } else console.log(transport, process.env.PROBE_V6 === '1' ? 'IPv6' : 'IPv4', result);
};
const timer = setTimeout(done, timeoutMs);
const message = () => {
    const address = socket.address();
    const local = process.env.PROBE_V6 === '1' ? '[' + address.address + ']' : address.address;
    return Buffer.from(
        'INVITE sip:scanner@firewall.test SIP/2.0\r\n' +
            `Via: SIP/2.0/${transport.toUpperCase()} ${local}:${address.port};branch=z9hG4bK-${id};rport\r\n` +
            `From: <sip:scanner@firewall.test>;tag=${id}\r\nTo: <sip:scanner@firewall.test>\r\n` +
            `Call-ID: ${id}\r\nCSeq: 1 INVITE\r\nMax-Forwards: 70\r\nContent-Length: 0\r\n\r\n`
    );
};
const read = data => {
    const status = [...data.toString().matchAll(/^SIP\/2\.0 (\d+)/gm)].map(match => match[1]).find(code => Number(code) >= 200);
    if (status && Number(status) >= 200) {
        result = status;
        done();
    }
};
if (transport === 'udp') {
    socket = dgram.createSocket(process.env.PROBE_V6 === '1' ? 'udp6' : 'udp4');
    socket.on('error', error => {
        console.error(error.message);
        process.exitCode = 1;
        done();
    });
    socket.on('message', read);
    socket.bind(0, process.env.PROBE_V6 === '1' ? '::' : '0.0.0.0', () => socket.send(message(), 5060, host));
} else {
    socket = net.connect({ host, port: 5060 });
    socket.on('connect', () => socket.write(message()));
    socket.on('data', read);
    socket.on('error', error => {
        console.error(error.message);
        process.exitCode = 1;
        done();
    });
}
