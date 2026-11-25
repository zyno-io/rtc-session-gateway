import { Resolver } from 'node:dns/promises';

export interface EndpointResolver {
    resolveCname(name: string): Promise<string[]>;
    resolveSrv(name: string): Promise<{ name: string; port?: number }[]>;
    resolve4(name: string): Promise<string[]>;
}

export interface DnsEndpoint {
    name: string;
    host: string;
    port: number;
}

export const endpointResolver = new Resolver({ timeout: 1000, tries: 1 });
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function discoveryService(value: string, prefix: string, namespace?: string): string {
    const service = value.replace(/\.$/, '');
    const parts = service.split('.');
    if (
        parts.length !== 5 ||
        !parts[0].startsWith(prefix) ||
        !parts.slice(0, 2).every(part => label.test(part)) ||
        (namespace && parts[1] !== namespace) ||
        parts[2] !== 'svc' ||
        !['cluster', 'clusterset'].includes(parts[3]) ||
        parts[4] !== 'local'
    )
        throw new Error('Invalid discovery Service name');
    return service;
}

function isFileDiscoveryService(service: string): boolean {
    const [name] = service.split('.');
    return name === 'edge-discovery-rtpfiles' || name.startsWith('edge-discovery-rtp-files');
}

export function fileDiscoveryService(value: string): string {
    const service = discoveryService(value, 'edge-discovery-rtp');
    if (!isFileDiscoveryService(service)) throw new Error('Invalid file discovery Service name');
    return service;
}

export async function resolveMediaAlias(alias: string, resolver: EndpointResolver): Promise<DnsEndpoint[]> {
    const names = await resolver.resolveCname(alias);
    if (names.length !== 1) throw new Error('Media alias must resolve to one Service');
    if (isFileDiscoveryService(names[0])) throw new Error('File discovery cannot admit new media sessions');
    const service = discoveryService(names[0], 'edge-discovery-rtp-', alias.split('.')[1]);
    return resolveControlEndpoints(service, resolver);
}

export async function resolveControlEndpoints(service: string, resolver: EndpointResolver, exactName?: string): Promise<DnsEndpoint[]> {
    const records = await resolver.resolveSrv('_control._tcp.' + service);
    if (records.length > 64) throw new Error('Discovery pool exceeds 64 SRV records');
    const portsByName = new Map<string, Set<number>>();
    for (const record of records) {
        const [name, ...suffix] = record.name.replace(/\.$/, '').split('.');
        if (!label.test(name) || suffix.join('.') !== service || (exactName !== undefined && exactName !== name)) continue;
        if (typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
        const ports = portsByName.get(name) ?? new Set<number>();
        ports.add(record.port);
        portsByName.set(name, ports);
    }
    const observed = await Promise.allSettled(
        [...portsByName].map(async ([name, ports]) => {
            if (ports.size !== 1) throw new Error('Ambiguous control port');
            const addresses = await resolver.resolve4(name + '.' + service);
            const hosts = new Set(addresses);
            if (hosts.size !== 1) throw new Error('Ambiguous control address');
            const port = [...ports][0];
            return { name, host: [...hosts][0], port };
        })
    );
    return observed.flatMap(result => (result.status === 'fulfilled' ? [result.value] : [])).sort((a, b) => a.name.localeCompare(b.name));
}
