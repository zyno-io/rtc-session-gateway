export type RouteMatchType = 'exact' | 'userPrefix';

export function getSipHost(uri: string): string | undefined {
    const value = stripSipUri(uri);
    if (!/^sips?:/i.test(value)) return undefined;
    const parts = value.replace(/^sips?:/i, '').split('@');
    if (parts.length > 2 || parts.some(part => !part || /[\s<>]/.test(part))) return undefined;
    const authority = parts.at(-1)!;
    const match = /^([a-zA-Z0-9.-]+)(?::[0-9]+)?$/.exec(authority);
    const host = match?.[1].toLowerCase().replace(/\.$/, '');
    return host && validHostname(host) ? host : undefined;
}

function validHostname(host: string): boolean {
    return host.length <= 253 && host.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

export function parseAllowedSipDomains(value: string | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    const domains: unknown = JSON.parse(value);
    if (!Array.isArray(domains) || !domains.length || domains.length > 128)
        throw new Error('SIP_ALLOWED_DOMAINS_JSON must contain exact SIP hostnames');
    return [
        ...new Set(
            domains.map(domain => {
                if (typeof domain !== 'string' || domain.length > 253 || !validHostname(domain.replace(/\.$/, '')))
                    throw new Error('Invalid allowed SIP domain');
                return domain.toLowerCase().replace(/\.$/, '');
            })
        )
    ];
}

export function acceptsSipHost(uri: string, domains?: readonly string[]): boolean {
    if (!domains) return true;
    const host = getSipHost(uri);
    return host !== undefined && domains.includes(host);
}

export interface RouteConfig {
    match: RouteMatchType;
    value: string;
    url: string;
}

export interface InviteDestination {
    destinationUri: string;
    destinationUser?: string;
}

export function parseRoutesJson(value: string | undefined) {
    if (!value?.trim()) return [];

    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('ROUTES_JSON must be an array');

    return parsed.map((route, index): RouteConfig => {
        if (!route || typeof route !== 'object') {
            throw new Error(`ROUTES_JSON[${index}] must be an object`);
        }

        const candidate = route as Record<string, unknown>;
        if (candidate.match !== 'exact' && candidate.match !== 'userPrefix') {
            throw new Error(`ROUTES_JSON[${index}].match must be "exact" or "userPrefix"`);
        }
        if (typeof candidate.value !== 'string' || !candidate.value.trim()) {
            throw new Error(`ROUTES_JSON[${index}].value must be a non-empty string`);
        }
        if (typeof candidate.url !== 'string' || !candidate.url.trim()) {
            throw new Error(`ROUTES_JSON[${index}].url must be a non-empty string`);
        }
        new URL(candidate.url);

        return {
            match: candidate.match,
            value: normalizeRouteValue(candidate.value),
            url: candidate.url
        };
    });
}

export function matchRoute(routes: RouteConfig[], destination: InviteDestination) {
    const destinationUri = normalizeRouteValue(destination.destinationUri);
    const destinationUser = destination.destinationUser ? normalizeRouteValue(destination.destinationUser) : undefined;

    return routes.find(route => {
        if (route.match === 'exact') {
            return route.value === destinationUri || route.value === destinationUser;
        }

        return destinationUri.startsWith(route.value) || !!destinationUser?.startsWith(route.value);
    });
}

export function normalizeRouteValue(value: string) {
    return stripSipUri(value).trim();
}

export function stripSipUri(value: string | undefined) {
    const trimmed = (value ?? '').trim();
    const nameAddr = /<([^>]+)>/.exec(trimmed);
    const uri = nameAddr?.[1] ?? trimmed;
    return uri.replace(/[?;].*$/, '');
}

export function getSipUser(uri: string | undefined) {
    const stripped = stripSipUri(uri);
    const withoutScheme = stripped.replace(/^sips?:/i, '');
    const atIndex = withoutScheme.indexOf('@');
    if (atIndex === -1) return withoutScheme || undefined;
    return withoutScheme.slice(0, atIndex) || undefined;
}
