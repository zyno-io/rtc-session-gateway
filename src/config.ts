import { parseRoutesJson, parseAllowedSipDomains, RouteConfig } from './routing';
import { parseIceUrls } from './endpoint-catalog';

export interface GatewayConfig {
    DRACHTIO_HOST: string;
    DRACHTIO_PORT: number;
    DRACHTIO_SECRET?: string;
    DRACHTIO_APP_TAG?: string;
    DRACHTIO_ROUTE_FALLBACK_URL?: string;
    HTTP_PORT: number;
    SHUTDOWN_MAX_WAIT_MS: number;
    SHUTDOWN_CLEANUP_TIMEOUT_MS: number;
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
    RTPBRIDGE_TLS: boolean;
    RTPBRIDGE_AUTH_HMAC_SECRET_FILE?: string;
    RTPBRIDGE_TLS_CA_FILE?: string;
    RTPBRIDGE_TLS_SERVERNAME?: string;
    RTPBRIDGE_ENDPOINTS_FILE?: string;
    RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT?: boolean;
    RTPBRIDGE_REQUIRED?: boolean;
    ROUTES_REQUIRED?: boolean;
    SIP_ALLOWED_DOMAINS?: string[];
    COTURN_URLS?: string[];
    COTURN_AUTH_SECRET?: string;
    COTURN_CREDENTIAL_TTL_SECONDS: number;
    RECORDINGS_PATH: string;
    RECORDING_PATH_PREFIX?: string;
    INVITE_HTTP_TIMEOUT_MS: number;
    EVENT_HTTP_TIMEOUT_MS: number;
    ROUTES: RouteConfig[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
    const controlAuthMode = readControlAuthMode(env);
    const mediaRequired = readBoolean(env.RTPBRIDGE_REQUIRED, false, 'RTPBRIDGE_REQUIRED');
    if (mediaRequired && !env.RTPBRIDGE_HOST && !env.RTPBRIDGE_ENDPOINTS_FILE) throw new Error('Required media needs RTPBRIDGE_HOST or RTPBRIDGE_ENDPOINTS_FILE');
    const iceUrls = env.COTURN_URLS_JSON ? parseIceUrls(JSON.parse(env.COTURN_URLS_JSON)) : undefined;
    if (iceUrls?.some(url => url.startsWith('turn')) && !env.COTURN_AUTH_SECRET) throw new Error('TURN URLs require COTURN_AUTH_SECRET');
    return {
        DRACHTIO_HOST: env.DRACHTIO_HOST || '127.0.0.1',
        DRACHTIO_PORT: readPositiveInteger(env.DRACHTIO_PORT, 9022, 'DRACHTIO_PORT'),
        DRACHTIO_SECRET: env.DRACHTIO_SECRET || undefined,
        DRACHTIO_APP_TAG: readDrachtioAppTag(env.DRACHTIO_APP_TAG),
        DRACHTIO_ROUTE_FALLBACK_URL: readOptionalUrl(env.DRACHTIO_ROUTE_FALLBACK_URL, 'DRACHTIO_ROUTE_FALLBACK_URL'),
        HTTP_PORT: readPositiveInteger(env.HTTP_PORT, 3001, 'HTTP_PORT'),
        SHUTDOWN_MAX_WAIT_MS: readPositiveInteger(env.SHUTDOWN_MAX_WAIT_MS, 1_800_000, 'SHUTDOWN_MAX_WAIT_MS'),
        SHUTDOWN_CLEANUP_TIMEOUT_MS: readPositiveInteger(env.SHUTDOWN_CLEANUP_TIMEOUT_MS, 5_000, 'SHUTDOWN_CLEANUP_TIMEOUT_MS'),
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
        RTPBRIDGE_TLS: readBoolean(env.RTPBRIDGE_TLS, false, 'RTPBRIDGE_TLS'),
        RTPBRIDGE_AUTH_HMAC_SECRET_FILE: env.RTPBRIDGE_AUTH_HMAC_SECRET_FILE || undefined,
        RTPBRIDGE_TLS_CA_FILE: env.RTPBRIDGE_TLS_CA_FILE || undefined,
        RTPBRIDGE_TLS_SERVERNAME: env.RTPBRIDGE_TLS_SERVERNAME || undefined,
        RTPBRIDGE_ENDPOINTS_FILE: env.RTPBRIDGE_ENDPOINTS_FILE || undefined,
        RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT: readBoolean(env.RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT, false, 'RTPBRIDGE_ENDPOINTS_ALLOW_PLAINTEXT'),
        ROUTES_REQUIRED: readBoolean(env.ROUTES_REQUIRED, false, 'ROUTES_REQUIRED'),
        RTPBRIDGE_REQUIRED: mediaRequired,
        SIP_ALLOWED_DOMAINS: parseAllowedSipDomains(env.SIP_ALLOWED_DOMAINS_JSON),
        COTURN_URLS: iceUrls,
        COTURN_AUTH_SECRET: env.COTURN_AUTH_SECRET || undefined,
        COTURN_CREDENTIAL_TTL_SECONDS: readPositiveInteger(env.COTURN_CREDENTIAL_TTL_SECONDS, 86_400, 'COTURN_CREDENTIAL_TTL_SECONDS'),
        RECORDINGS_PATH: env.RECORDINGS_PATH || '/var/lib/rtpbridge/recordings',
        RECORDING_PATH_PREFIX: readRecordingPathPrefix(env.RECORDING_PATH_PREFIX),
        INVITE_HTTP_TIMEOUT_MS: readPositiveInteger(env.INVITE_HTTP_TIMEOUT_MS, 15_000, 'INVITE_HTTP_TIMEOUT_MS'),
        EVENT_HTTP_TIMEOUT_MS: readPositiveInteger(env.EVENT_HTTP_TIMEOUT_MS, 15_000, 'EVENT_HTTP_TIMEOUT_MS'),
        ROUTES: parseRoutesJson(env.ROUTES_JSON)
    };
}

function readRecordingPathPrefix(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || value === '.' || value === '..') {
        throw new Error('RECORDING_PATH_PREFIX must be a simple filename prefix');
    }
    return value;
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

function readBoolean(value: string | undefined, fallback: boolean, name: string) {
    if (value === undefined || value === '') return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`${name} must be true or false`);
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
