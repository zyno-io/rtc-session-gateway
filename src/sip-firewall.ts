import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { addressRange, blockRange, overlaps, overlapsLoopback, sourceIp, type AddressRange } from './firewall-address';
import { BaseLogger } from './logger';
import { FIREWALL_MAX_ALLOWS, FIREWALL_MAX_BLOCKS, FIREWALL_MAX_TTL_MS, type FirewallSnapshot } from './firewall-contract';

export interface SipFirewallConfig {
    mode: 'off' | 'shadow' | 'enforce';
    allowlist: string[];
    threshold: number;
    halfLifeMs: number;
    banTtlsSec: number[];
    maxRecords: number;
    maxBlocks: number;
    adminToken?: string;
    snapshotToken?: string;
    observeUnknownReplaces: boolean;
    /** After a control owner disconnects, no-route misses are not scored for this long. */
    routeGraceMs: number;
    publisherUrl?: string;
    publisherToken?: string;
    publisherCaFile?: string;
}

export function loadFirewallConfig(env: NodeJS.ProcessEnv = process.env): SipFirewallConfig {
    const mode = env.SIP_FIREWALL_MODE ?? 'shadow';
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') throw new Error('Invalid SIP_FIREWALL_MODE');
    const number = (name: string, fallback: number, max: number) => {
        const value = Number(env[name] ?? fallback);
        if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error('Invalid ' + name);
        return value;
    };
    const targets = (name: string, max: number) => {
        const value: unknown = JSON.parse(env[name] ?? '[]');
        if (!Array.isArray(value) || value.length > max) throw new Error('Invalid ' + name);
        return [...new Set(value.map(entry => addressRange(entry).target))];
    };
    const banTtlsSec = (env.SIP_FIREWALL_BAN_TTLS_SEC ?? '900,3600,21600,86400').split(',').map(Number);
    if (
        !banTtlsSec.length ||
        banTtlsSec.length > 16 ||
        banTtlsSec.some((ttl, i) => !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400 || (i > 0 && ttl < banTtlsSec[i - 1]))
    )
        throw new Error('Invalid SIP_FIREWALL_BAN_TTLS_SEC');
    const routeGraceMs = Number(env.SIP_FIREWALL_ROUTE_GRACE_MS ?? 300_000);
    if (!Number.isSafeInteger(routeGraceMs) || routeGraceMs < 0 || routeGraceMs > 86_400_000) throw new Error('Invalid SIP_FIREWALL_ROUTE_GRACE_MS');
    const publisherUrl = env.SIP_FIREWALL_PUBLISHER_URL;
    if (publisherUrl) {
        const url = new URL(publisherUrl);
        if (
            (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/v1/snapshot'
        )
            throw new Error('Publisher must use HTTPS or loopback HTTP /v1/snapshot');
        if (!env.SIP_FIREWALL_PUBLISHER_TOKEN) throw new Error('SIP_FIREWALL_PUBLISHER_TOKEN is required');
    }
    return {
        mode,
        allowlist: targets('SIP_FIREWALL_ALLOWLIST_JSON', FIREWALL_MAX_ALLOWS),
        observeUnknownReplaces: env.SIP_FIREWALL_OBSERVE_UNKNOWN_REPLACES === 'true',
        routeGraceMs,
        threshold: number('SIP_FIREWALL_THRESHOLD', 10, 10000),
        halfLifeMs: number('SIP_FIREWALL_HALF_LIFE_MS', 600_000, 86_400_000),
        banTtlsSec,
        maxRecords: number('SIP_FIREWALL_MAX_RECORDS', 100_000, 100_000),
        maxBlocks: number('SIP_FIREWALL_MAX_BLOCKS', FIREWALL_MAX_BLOCKS, FIREWALL_MAX_BLOCKS),
        adminToken: env.SIP_FIREWALL_ADMIN_TOKEN,
        snapshotToken: env.SIP_FIREWALL_SNAPSHOT_TOKEN,
        publisherUrl,
        publisherToken: env.SIP_FIREWALL_PUBLISHER_TOKEN,
        publisherCaFile: env.SIP_FIREWALL_PUBLISHER_CA_FILE
    };
}

interface ScoreRecord {
    score: number;
    updatedAt: number;
    tier: number;
    lastBan: number;
}
export interface FirewallBlock {
    target: string;
    expiresAt: number;
    reason: string;
    kind: 'manual' | 'automatic';
    tier?: number;
}

export class SipFirewall extends EventEmitter {
    readonly instanceId = randomUUID();
    readonly startedAt: string;
    private revision = 0;
    private readonly records = new Map<string, ScoreRecord>();
    private readonly automatic = new Map<string, FirewallBlock>();
    private readonly manual = new Map<string, FirewallBlock>();
    // Parsed once at creation; kept out of block objects so snapshots/API output never serialize it.
    private readonly manualRanges = new WeakMap<FirewallBlock, AddressRange>();
    private readonly markers = new Map<string, number>();
    private readonly allow: AddressRange[];
    private recordCursor?: MapIterator<[string, ScoreRecord]>;
    private markerCursor?: MapIterator<[string, number]>;
    readonly counters = { invalidSources: 0, skipped: 0, observations: 0, wouldBan: 0, bans: 0 };

    constructor(
        readonly config: SipFirewallConfig = loadFirewallConfig(),
        private readonly now: () => number = Date.now
    ) {
        super();
        this.startedAt = new Date(now()).toISOString();
        this.allow = config.allowlist.map(addressRange);
    }

    isAllowed(target: string): boolean {
        const range = addressRange(target);
        return this.allow.some(allowed => overlaps(range, allowed));
    }

    shouldReject(value: unknown): boolean {
        if (this.config.mode !== 'enforce') return false;
        const ip = sourceIp(value);
        if (!ip) {
            this.counters.invalidSources++;
            return false;
        }
        if (this.isAllowed(ip)) return false;
        const range = addressRange(ip);
        const now = this.now();
        const auto = this.automatic.get(scoreKey(ip));
        if (auto && auto.expiresAt > now) return true;
        for (const block of this.manual.values()) {
            const manualRange = this.manualRanges.get(block);
            if (block.expiresAt > now && manualRange && overlaps(range, manualRange)) return true;
        }
        return false;
    }

    observe(value: unknown, target: string | undefined, reason: string, requestId?: string, replacement = false): void {
        if (this.config.mode === 'off') return;
        // Unknown-Replaces observations are opt-in; callers flag them with replacement=true.
        if (replacement && !this.config.observeUnknownReplaces) return;
        const ip = sourceIp(value);
        if (!ip) {
            this.counters.invalidSources++;
            return;
        }
        // Loopback is never scored; IPv6 sources are scored and banned per /64 so rotating within a prefix accumulates.
        const key = scoreKey(ip);
        if (overlapsLoopback(addressRange(ip)) || overlapsLoopback(addressRange(key))) return;
        if (this.isAllowed(key) || this.shouldReject(ip)) return;
        const now = this.now();
        // Deduplicates redelivery of one sipbridge request; distinct requests (even with equal Call-ID/CSeq) each score.
        if (requestId) {
            const key = createHash('sha256').update(ip).update('\0').update(requestId).digest('hex');
            if ((this.markers.get(key) ?? 0) > now) return;
            if (this.markers.size >= this.config.maxRecords) {
                this.counters.skipped++;
                return;
            }
            this.markers.set(key, now + 60_000);
        }
        let record = this.records.get(key);
        if (!record) {
            if (this.records.size >= this.config.maxRecords) {
                this.counters.skipped++;
                return;
            }
            record = { score: 0, updatedAt: now, tier: 0, lastBan: 0 };
            this.records.set(key, record);
        }
        if (record.lastBan && now - record.lastBan > FIREWALL_MAX_TTL_MS) record.tier = 0;
        let dialTarget = target ?? '';
        try {
            dialTarget = decodeURIComponent(dialTarget);
        } catch {
            // Malformed escapes remain an ordinary invalid destination.
        }
        const weight = replacement ? 1 : /^(?:00|011|000)\d{3,}$/.test(dialTarget) ? 2 : /^(?:\+?1)?\d{10}$/.test(dialTarget) ? 0.25 : 1;
        record.score = record.score * Math.pow(2, -Math.max(0, now - record.updatedAt) / this.config.halfLifeMs) + weight;
        record.updatedAt = now;
        this.counters.observations++;
        if (record.score < this.config.threshold) return;
        if (this.config.mode === 'shadow') {
            this.counters.wouldBan++;
            record.score = 0;
            return;
        }
        this.pruneBlocks(now);
        if (!this.automatic.has(key) && this.manual.size + this.automatic.size >= this.config.maxBlocks) {
            this.counters.skipped++;
            return;
        }
        const tier = Math.min(record.tier, this.config.banTtlsSec.length - 1);
        const block: FirewallBlock = {
            target: key,
            expiresAt: now + this.config.banTtlsSec[tier] * 1000,
            kind: 'automatic',
            reason: reason.slice(0, 128),
            tier
        };
        this.automatic.set(key, block);
        BaseLogger.child({ ns: 'SipFirewall' }).info(
            { sourceIp: key, tier, reason: block.reason, ttlSec: this.config.banTtlsSec[tier] },
            'Firewall ban'
        );
        record.tier = Math.min(tier + 1, this.config.banTtlsSec.length - 1);
        record.lastBan = now;
        record.score = 0;
        this.counters.bans++;
        this.changed();
    }

    ban(target: unknown, ttlSeconds: unknown, reason: unknown): void {
        if (this.config.mode !== 'enforce') throw new Error('Manual bans require enforce mode');
        const range = blockRange(target);
        const normalized = range.target;
        if (overlapsLoopback(range)) throw new Error('Target overlaps loopback');
        if (
            typeof ttlSeconds !== 'number' ||
            !Number.isSafeInteger(ttlSeconds) ||
            ttlSeconds <= 0 ||
            ttlSeconds * 1000 > FIREWALL_MAX_TTL_MS ||
            typeof reason !== 'string' ||
            !reason.trim() ||
            reason.length > 128
        )
            throw new Error('Ban requires a finite TTL and reason');
        if (this.isAllowed(normalized)) throw new Error('Target overlaps allowlist');
        this.pruneBlocks(this.now());
        if (!this.manual.has(normalized) && this.manual.size + this.automatic.size >= this.config.maxBlocks)
            throw new Error('Firewall block capacity reached');
        const block: FirewallBlock = {
            target: normalized,
            expiresAt: this.now() + ttlSeconds * 1000,
            reason,
            kind: 'manual'
        };
        this.manualRanges.set(block, range);
        this.manual.set(normalized, block);
        this.changed();
    }

    unblock(target: unknown): void {
        const range = addressRange(target);
        const normalized = range.target;
        this.manual.delete(normalized);
        this.automatic.delete(normalized);
        this.records.delete(normalized);
        if (range.family === 6 && range.prefix === 128) {
            const key = scoreKey(normalized);
            this.automatic.delete(key);
            this.records.delete(key);
        }
        this.changed();
    }

    blocks(): FirewallBlock[] {
        this.pruneBlocks(this.now());
        return [...this.manual.values(), ...this.automatic.values()];
    }

    snapshot(): FirewallSnapshot {
        const blocks = new Map<string, number>();
        for (const block of this.blocks()) {
            if (!this.isAllowed(block.target)) blocks.set(block.target, Math.max(blocks.get(block.target) ?? 0, block.expiresAt));
        }
        return {
            schemaVersion: 1,
            instanceId: this.instanceId,
            startedAt: this.startedAt,
            revision: this.revision,
            generatedAt: new Date(this.now()).toISOString(),
            allowlist: [...this.config.allowlist],
            blocks:
                this.config.mode === 'enforce'
                    ? [...blocks].map(([target, expiry]) => ({
                          target,
                          expiresAt: new Date(expiry).toISOString()
                      }))
                    : []
        };
    }

    status() {
        this.pruneBlocks(this.now());
        return {
            mode: this.config.mode,
            instanceId: this.instanceId,
            revision: this.revision,
            records: this.records.size,
            automatic: this.automatic.size,
            manual: this.manual.size,
            counters: { ...this.counters }
        };
    }

    /** Bound each sweep; attacker cardinality must not create long call-path pauses. */
    sweep(limit = 1000): void {
        const now = this.now();
        this.pruneBlocks(now);
        this.recordCursor ??= this.records.entries();
        this.markerCursor ??= this.markers.entries();
        for (let i = 0; i < limit; i++) {
            const entry = this.recordCursor.next();
            if (entry.done) {
                this.recordCursor = undefined;
                break;
            }
            const [ip, record] = entry.value;
            if (
                !this.automatic.has(ip) &&
                now - record.updatedAt > 10 * this.config.halfLifeMs &&
                (!record.lastBan || now - record.lastBan > FIREWALL_MAX_TTL_MS)
            )
                this.records.delete(ip);
        }
        for (let i = 0; i < limit; i++) {
            const entry = this.markerCursor.next();
            if (entry.done) {
                this.markerCursor = undefined;
                break;
            }
            if (entry.value[1] <= now) this.markers.delete(entry.value[0]);
        }
    }

    private pruneBlocks(now: number): void {
        let changed = false;
        for (const map of [this.manual, this.automatic])
            for (const [target, block] of map)
                if (block.expiresAt <= now) {
                    map.delete(target);
                    changed = true;
                }
        if (changed) this.changed();
    }

    private changed(): void {
        this.revision++;
        this.emit('change');
    }
}

/** Automatic scoring granularity: IPv4 /32, IPv6 /64 (a single subscriber can rotate through a whole /64). */
function scoreKey(ip: string): string {
    const range = addressRange(ip);
    return range.family === 6 ? addressRange(ip + '/64').target : ip;
}
