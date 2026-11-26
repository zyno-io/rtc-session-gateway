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

export function discoveryService(value: string, namespace?: string): string {
    const service = value.replace(/\.$/, '');
    const parts = service.split('.');
    if (
        service.length > 253 ||
        parts.length < 4 ||
        !parts.every(part => label.test(part)) ||
        (namespace && parts[1] !== namespace) ||
        parts[2] !== 'svc'
    )
        throw new Error('Invalid discovery Service name');
    return service;
}

export async function resolveMediaAlias(alias: string, resolver: EndpointResolver, fileService?: string): Promise<DnsEndpoint[]> {
    const names = await resolver.resolveCname(alias);
    if (names.length !== 1) throw new Error('Media alias must resolve to one Service');
    const service = discoveryService(names[0], alias.split('.')[1]);
    if (fileService && service.split('.', 2).join('.') === fileService.split('.', 2).join('.')) {
        throw new Error('File discovery cannot admit new media sessions');
    }
    return resolveControlEndpoints(service, resolver);
}

export async function resolveControlEndpoints(service: string, resolver: EndpointResolver, names?: ReadonlySet<string>): Promise<DnsEndpoint[]> {
    const records = await resolver.resolveSrv('_control._tcp.' + service);
    if (records.length > 64) throw new Error('Discovery pool exceeds 64 SRV records');
    const coordinatesByName = new Map<string, { targets: Set<string>; ports: Set<number> }>();
    for (const record of records) {
        const target = record.name.replace(/\.$/, '');
        const [name, ...suffix] = target.split('.');
        const local = suffix.join('.') === service;
        const clusterQualified = label.test(suffix[0] ?? '') && suffix.slice(1).join('.') === service;
        if (!label.test(name) || (!local && !clusterQualified) || (names && !names.has(name))) continue;
        if (typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
        const coordinates = coordinatesByName.get(name) ?? { targets: new Set<string>(), ports: new Set<number>() };
        coordinates.targets.add(target);
        coordinates.ports.add(record.port);
        coordinatesByName.set(name, coordinates);
    }
    const observed = await Promise.allSettled(
        [...coordinatesByName].map(async ([name, { targets, ports }]) => {
            if (targets.size !== 1 || ports.size !== 1) throw new Error('Ambiguous control target');
            const addresses = await resolver.resolve4([...targets][0]);
            const hosts = new Set(addresses);
            if (hosts.size !== 1) throw new Error('Ambiguous control address');
            const port = [...ports][0];
            return { name, host: [...hosts][0], port };
        })
    );
    return observed.flatMap(result => (result.status === 'fulfilled' ? [result.value] : [])).sort((a, b) => a.name.localeCompare(b.name));
}
