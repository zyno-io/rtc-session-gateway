import { parseRoutesJson, RouteConfig } from './routing';

export interface GatewayConfig {
    DRACHTIO_HOST: string;
    DRACHTIO_PORT: number;
    DRACHTIO_SECRET?: string;
    DRACHTIO_APP_TAG?: string;
    DRACHTIO_ROUTE_FALLBACK_URL?: string;
    HTTP_PORT: number;
    CONTROL_WS_PATH: string;
    CONTROL_AUTH_MODE: 'bearer' | 'none';
    CONTROL_AUTH_TOKEN?: string;
    CONTROL_MAX_PAYLOAD_BYTES: number;
    CONTROL_REQUEST_TIMEOUT_MS: number;
    RTPBRIDGE_HOST?: string;
    RTPBRIDGE_PORT: number;
    RTPBRIDGE_SRV_PORT_NAME: string;
    RTPBRIDGE_REQUEST_TIMEOUT_MS: number;
    RTPBRIDGE_CONNECTION_TIMEOUT_MS: number;
    RECORDINGS_PATH: string;
    INVITE_HTTP_TIMEOUT_MS: number;
    EVENT_HTTP_TIMEOUT_MS: number;
    ROUTES: RouteConfig[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
    const controlAuthMode = readControlAuthMode(env);
    return {
        DRACHTIO_HOST: env.DRACHTIO_HOST || '127.0.0.1',
        DRACHTIO_PORT: readPositiveInteger(env.DRACHTIO_PORT, 9022, 'DRACHTIO_PORT'),
        DRACHTIO_SECRET: env.DRACHTIO_SECRET || undefined,
        DRACHTIO_APP_TAG: readDrachtioAppTag(env.DRACHTIO_APP_TAG),
        DRACHTIO_ROUTE_FALLBACK_URL: readOptionalUrl(env.DRACHTIO_ROUTE_FALLBACK_URL, 'DRACHTIO_ROUTE_FALLBACK_URL'),
        HTTP_PORT: readPositiveInteger(env.HTTP_PORT, 3001, 'HTTP_PORT'),
        CONTROL_WS_PATH: env.CONTROL_WS_PATH || '/control',
        CONTROL_AUTH_MODE: controlAuthMode,
        CONTROL_AUTH_TOKEN: env.CONTROL_AUTH_TOKEN || undefined,
        CONTROL_MAX_PAYLOAD_BYTES: readPositiveInteger(env.CONTROL_MAX_PAYLOAD_BYTES, 1_048_576, 'CONTROL_MAX_PAYLOAD_BYTES'),
        CONTROL_REQUEST_TIMEOUT_MS: readPositiveInteger(env.CONTROL_REQUEST_TIMEOUT_MS, 15_000, 'CONTROL_REQUEST_TIMEOUT_MS'),
        RTPBRIDGE_HOST: env.RTPBRIDGE_HOST || undefined,
        RTPBRIDGE_PORT: readPositiveInteger(env.RTPBRIDGE_PORT, 9_100, 'RTPBRIDGE_PORT'),
        RTPBRIDGE_SRV_PORT_NAME: env.RTPBRIDGE_SRV_PORT_NAME || 'ws',
        RTPBRIDGE_REQUEST_TIMEOUT_MS: readPositiveInteger(env.RTPBRIDGE_REQUEST_TIMEOUT_MS, 10_000, 'RTPBRIDGE_REQUEST_TIMEOUT_MS'),
        RTPBRIDGE_CONNECTION_TIMEOUT_MS: readPositiveInteger(env.RTPBRIDGE_CONNECTION_TIMEOUT_MS, 5_000, 'RTPBRIDGE_CONNECTION_TIMEOUT_MS'),
        RECORDINGS_PATH: env.RECORDINGS_PATH || '/var/lib/rtpbridge/recordings',
        INVITE_HTTP_TIMEOUT_MS: readPositiveInteger(env.INVITE_HTTP_TIMEOUT_MS, 15_000, 'INVITE_HTTP_TIMEOUT_MS'),
        EVENT_HTTP_TIMEOUT_MS: readPositiveInteger(env.EVENT_HTTP_TIMEOUT_MS, 15_000, 'EVENT_HTTP_TIMEOUT_MS'),
        ROUTES: parseRoutesJson(env.ROUTES_JSON)
    };
}

function readDrachtioAppTag(value: string | undefined) {
    if (!value?.trim()) return undefined;
    const tag = value.trim();
    if (tag.length > 32 || !/^[a-zA-Z0-9-_+@:]+$/.test(tag)) {
        throw new Error('DRACHTIO_APP_TAG must be at most 32 characters and contain only letters, numbers, -, _, +, @, or :');
    }
    return tag;
}

function readOptionalUrl(value: string | undefined, name: string) {
    if (!value?.trim()) return undefined;
    try {
        return new URL(value).toString();
    } catch {
        throw new Error(`${name} must be a valid URL`);
    }
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string) {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

function readControlAuthMode(env: NodeJS.ProcessEnv): GatewayConfig['CONTROL_AUTH_MODE'] {
    if (env.CONTROL_AUTH_MODE) {
        if (env.CONTROL_AUTH_MODE !== 'bearer' && env.CONTROL_AUTH_MODE !== 'none') {
            throw new Error('CONTROL_AUTH_MODE must be bearer or none');
        }
        if (env.CONTROL_AUTH_MODE === 'bearer' && !env.CONTROL_AUTH_TOKEN) {
            throw new Error('CONTROL_AUTH_TOKEN is required when CONTROL_AUTH_MODE=bearer');
        }
        return env.CONTROL_AUTH_MODE;
    }

    if (env.CONTROL_AUTH_TOKEN) return 'bearer';
    if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
        throw new Error('CONTROL_AUTH_TOKEN is required in production unless CONTROL_AUTH_MODE=none is set explicitly');
    }
    return 'none';
}

export const Config = loadConfig();
