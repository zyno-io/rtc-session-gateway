export type RouteMatchType = 'exact' | 'userPrefix';

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
