import { addressRange, blockRange } from './firewall-address';

export const FIREWALL_MAX_BYTES = 2 * 1024 * 1024;
export const FIREWALL_MAX_BLOCKS = 10_000;
export const FIREWALL_MAX_ALLOWS = 2_000;
export const FIREWALL_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FirewallSnapshot {
    schemaVersion: 1;
    instanceId: string;
    startedAt: string;
    revision: number;
    generatedAt: string;
    allowlist: string[];
    blocks: { target: string; expiresAt: string }[];
}

export function parseFirewallSnapshot(value: unknown, now = Date.now()): FirewallSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid firewall snapshot');
    const object = value as Record<string, unknown>;
    if (
        object.schemaVersion !== 1 ||
        typeof object.instanceId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,96}$/.test(object.instanceId) ||
        !Number.isSafeInteger(object.revision) ||
        (object.revision as number) < 0 ||
        !Array.isArray(object.allowlist) ||
        object.allowlist.length > FIREWALL_MAX_ALLOWS ||
        !Array.isArray(object.blocks) ||
        object.blocks.length > FIREWALL_MAX_BLOCKS
    )
        throw new Error('Invalid firewall snapshot');
    const startedAt = timestamp(object.startedAt);
    const generatedAt = timestamp(object.generatedAt);
    if (
        Date.parse(startedAt) > now + 5_000 ||
        Date.parse(generatedAt) > now + 5_000 ||
        Date.parse(generatedAt) < Date.parse(startedAt) ||
        now - Date.parse(generatedAt) > 60_000
    )
        throw new Error('Stale firewall snapshot');
    const allowlist = object.allowlist.map(entry => addressRange(entry).target);
    const blocks = object.blocks.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid firewall block');
        const block = entry as Record<string, unknown>;
        const target = blockRange(block.target).target;
        const expiresAt = timestamp(block.expiresAt);
        if (Date.parse(expiresAt) > Date.parse(generatedAt) + FIREWALL_MAX_TTL_MS) throw new Error('Invalid firewall expiry');
        return { target, expiresAt };
    });
    if (new Set(allowlist).size !== allowlist.length || new Set(blocks.map(block => block.target)).size !== blocks.length)
        throw new Error('Duplicate firewall target');
    return {
        schemaVersion: 1,
        instanceId: object.instanceId,
        startedAt,
        revision: object.revision as number,
        generatedAt,
        allowlist,
        blocks
    };
}

function timestamp(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Invalid firewall timestamp');
    if (new Date(value).toISOString() !== value) throw new Error('Invalid firewall timestamp');
    return value;
}
