import { createHash } from 'node:crypto';
import { addressRange, overlaps } from './firewall-address';
import { parseFirewallSnapshot, type FirewallSnapshot } from './firewall-contract';

export interface FirewallBackend {
    reset(): Promise<void>;
    add(target: string, ttlSeconds: number): Promise<void>;
    remove(target: string): Promise<void>;
}

/** One desired snapshot, one serialized apply, and a bounded mirror; no update/event history. */
export class FirewallReconciler {
    private current?: FirewallSnapshot;
    private digest?: string;
    private initialized = false;
    private readonly mirror = new Map<string, number>();
    private applying?: Promise<void>;
    private pending = false;
    readonly status = {
        receivedAt: undefined as string | undefined,
        appliedAt: undefined as string | undefined,
        appliedInstanceId: undefined as string | undefined,
        appliedRevision: undefined as number | undefined,
        errors: 0,
        lastError: undefined as string | undefined
    };

    constructor(
        private readonly backend: FirewallBackend,
        private readonly now: () => number = Date.now
    ) {}

    accept(value: unknown): void {
        const snapshot = parseFirewallSnapshot(value, this.now());
        const digest = createHash('sha256')
            .update(JSON.stringify([snapshot.allowlist, snapshot.blocks]))
            .digest('hex');
        if (this.current) {
            if (snapshot.instanceId === this.current.instanceId) {
                if (
                    snapshot.startedAt !== this.current.startedAt ||
                    snapshot.revision < this.current.revision ||
                    (snapshot.revision === this.current.revision && digest !== this.digest)
                )
                    throw new Error('Conflicting firewall revision');
            } else if (Date.parse(snapshot.startedAt) <= Date.parse(this.current.startedAt)) throw new Error('Superseded firewall owner');
        }
        this.current = snapshot;
        this.digest = digest;
        this.status.receivedAt = new Date(this.now()).toISOString();
    }

    get state() {
        return {
            ...this.status,
            instanceId: this.current?.instanceId,
            revision: this.current?.revision,
            active: this.mirror.size
        };
    }

    reconcile(): Promise<void> {
        this.pending = true;
        if (!this.applying)
            this.applying = this.run().finally(() => {
                this.applying = undefined;
            });
        return this.applying;
    }

    /** HTTP updates/ticks share one error handler even while a kernel apply stalls. */
    schedule(): void {
        this.pending = true;
        if (!this.applying) void this.reconcile().catch(() => undefined);
    }

    private async run(): Promise<void> {
        try {
            while (this.pending) {
                this.pending = false;
                if (!this.current) return;
                if (!this.initialized) {
                    this.mirror.clear();
                    await this.backend.reset();
                    this.initialized = true;
                }
                const snapshot = this.current;
                const allow = snapshot.allowlist.map(addressRange);
                const desired = new Map<string, number>();
                // Native interval sets cannot represent overlapping CIDRs/hosts independently.
                // Retain all candidates in the snapshot, but install only the outer active range.
                // A narrower candidate is reconsidered when its covering range expires/removes.
                const candidates = snapshot.blocks
                    .map(block => ({ ...block, range: addressRange(block.target) }))
                    .sort(
                        (left, right) =>
                            left.range.family - right.range.family ||
                            (left.range.first < right.range.first
                                ? -1
                                : left.range.first > right.range.first
                                  ? 1
                                  : left.range.last > right.range.last
                                    ? -1
                                    : left.range.last < right.range.last
                                      ? 1
                                      : 0)
                    );
                let covering: ReturnType<typeof addressRange> | undefined;
                for (const block of candidates) {
                    const range = block.range;
                    const expiresAt = Date.parse(block.expiresAt);
                    if (expiresAt <= this.now() || allow.some(entry => overlaps(range, entry))) continue;
                    if (covering?.family === range.family && covering.first <= range.first && covering.last >= range.last) continue;
                    desired.set(block.target, expiresAt);
                    covering = range;
                }
                for (const target of this.mirror.keys())
                    if (!desired.has(target)) {
                        await this.backend.remove(target);
                        this.mirror.delete(target);
                    }
                for (const [target, expiresAt] of desired) {
                    if (this.mirror.get(target) === expiresAt) continue;
                    if (this.mirror.has(target)) {
                        await this.backend.remove(target);
                        this.mirror.delete(target);
                    }
                    const remaining = expiresAt - this.now();
                    if (remaining <= 0) continue;
                    await this.backend.add(target, Math.ceil(remaining / 1000));
                    this.mirror.set(target, expiresAt);
                }
                this.status.appliedAt = new Date(this.now()).toISOString();
                this.status.appliedInstanceId = snapshot.instanceId;
                this.status.appliedRevision = snapshot.revision;
                this.status.lastError = undefined;
            }
        } catch (error) {
            this.status.errors++;
            this.status.lastError = error instanceof Error ? error.message.slice(0, 256) : 'Kernel apply failed';
            throw error;
        }
    }
}
