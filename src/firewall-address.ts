import { isIP } from 'node:net';

export interface AddressRange {
    target: string;
    family: 4 | 6;
    first: bigint;
    last: bigint;
}

/** Canonical numeric addresses only; no DNS, zone identifiers, ports, or shell syntax. */
export function addressRange(value: unknown): AddressRange {
    if (typeof value !== 'string' || value.length > 64 || !/^[a-fA-F0-9:./]+$/.test(value)) throw new Error('Invalid IP/CIDR');
    const parts = value.split('/');
    if (parts.length > 2) throw new Error('Invalid IP/CIDR');
    let address = parts[0];
    let family = isIP(address);
    if (!family) throw new Error('Invalid IP/CIDR');
    const bits = family === 4 ? 32 : 128;
    let prefix = parts[1] === undefined ? bits : Number(parts[1]);
    if (parts[1] !== undefined && !/^\d{1,3}$/.test(parts[1])) throw new Error('Invalid CIDR prefix');
    if (prefix < 0 || prefix > bits) throw new Error('Invalid CIDR prefix');
    let numeric: bigint;
    if (family === 4) numeric = ipv4Number(address);
    else {
        if (address.includes('.')) {
            const lastColon = address.lastIndexOf(':');
            const tail = ipv4Number(address.slice(lastColon + 1));
            address = address.slice(0, lastColon + 1) + (tail >> 16n).toString(16) + ':' + (tail & 65535n).toString(16);
        }
        const halves = address.split('::');
        const head = halves[0] ? halves[0].split(':') : [];
        const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
        const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
        numeric = groups.reduce((result, group) => (result << 16n) | BigInt('0x' + group), 0n);
        if (numeric >> 32n === 65535n && prefix >= 96) {
            family = 4;
            prefix -= 96;
            numeric &= 0xffffffffn;
        }
    }
    const width = family === 4 ? 32 : 128;
    const hostMask = (1n << BigInt(width - prefix)) - 1n;
    const first = numeric & ~hostMask;
    const last = first | hostMask;
    const canonical =
        family === 4
            ? [24n, 16n, 8n, 0n].map(shift => Number((first >> shift) & 255n)).join('.')
            : Array.from({ length: 8 }, (_, i) => ((first >> BigInt((7 - i) * 16)) & 65535n).toString(16)).join(':');
    return {
        target: canonical + (prefix === width ? '' : '/' + prefix),
        family: family as 4 | 6,
        first,
        last
    };
}

function ipv4Number(address: string): bigint {
    return address.split('.').reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

export function sourceIp(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.includes('/')) return undefined;
    try {
        return addressRange(value).target;
    } catch {
        return undefined;
    }
}

export function overlaps(left: AddressRange, right: AddressRange): boolean {
    return left.family === right.family && left.first <= right.last && right.first <= left.last;
}
