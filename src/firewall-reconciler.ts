import { createHash } from 'node:crypto';
import { addressRange, LOOPBACK_RANGES, overlaps, type AddressRange } from './firewall-address';
import { parseFirewallSnapshot, type FirewallSnapshot } from './firewall-contract';
import { BaseLogger } from './logger';

const logger = BaseLogger.child({ ns: 'FirewallReconciler' });
const OWNER_STALE_MS = 60_000;

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
    /** Targets whose last kernel add failed; they must not suppress the narrower bans they would cover. */
    private readonly addFailed = new Set<string>();
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

    private readonly protectedRanges: AddressRange[];

    /** `protectedCidrs` are sidecar-local and never overridable by a snapshot; loopback is always included. */
    constructor(
        private readonly backend: FirewallBackend,
        private readonly now: () => number = Date.now,
        protectedCidrs: string[] = []
    ) {
        this.protectedRanges = [...LOOPBACK_RANGES, ...protectedCidrs.map(addressRange)];
    }

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
            } else if (
                Date.parse(snapshot.startedAt) <= Date.parse(this.current.startedAt) &&
                // A stepped clock can make a legitimate new instance look older; a silent owner forfeits fencing.
                this.now() - Date.parse(this.current.generatedAt) <= OWNER_STALE_MS
            )
                throw new Error('Superseded firewall owner');
        }
        this.current = snapshot;
        this.digest = digest;
        this.status.receivedAt = new Date(this.now()).toISOString();
    }

    /** An identical re-publication replaces the object but not the desired state; only instance/revision changes matter. */
    private sameRevision(snapshot: FirewallSnapshot): boolean {
        return this.current?.instanceId === snapshot.instanceId && this.current?.revision === snapshot.revision;
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

    /** Eligible targets (unexpired, not allow-listed) a snapshot asks for, with the latest expiry per target. */
    private requestedBy(snapshot: FirewallSnapshot): Map<string, number> {
        const cached = this.requestedIndex.get(snapshot);
        if (cached) return cached;
        const requested = this.computeRequested(snapshot);
        this.requestedIndex.set(snapshot, requested);
        return requested;
    }

    /** The per-snapshot index is reused by every per-mutation recheck of a pass (rebuilding it per removal is O(N^2)). */
    private readonly requestedIndex = new WeakMap<FirewallSnapshot, Map<string, number>>();

    private computeRequested(snapshot: FirewallSnapshot): Map<string, number> {
        const allow = [...snapshot.allowlist.map(addressRange), ...this.protectedRanges];
        const requested = new Map<string, number>();
        for (const block of snapshot.blocks) {
            const expiresAt = Date.parse(block.expiresAt);
            if (expiresAt <= this.now() || allow.some(entry => overlaps(addressRange(block.target), entry))) continue;
            requested.set(block.target, Math.max(expiresAt, requested.get(block.target) ?? 0));
        }
        return requested;
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
                const allow = [...snapshot.allowlist.map(addressRange), ...this.protectedRanges];
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
                // Every eligible target the snapshot asks for, kept before overlapping ranges are collapsed, so a covered
                // installed entry is only restored when the current snapshot still independently requests it.
                const requested = new Map<string, number>();
                let covering: ReturnType<typeof addressRange> | undefined;
                for (const block of candidates) {
                    const range = block.range;
                    const expiresAt = Date.parse(block.expiresAt);
                    if (expiresAt <= this.now() || allow.some(entry => overlaps(range, entry))) continue;
                    requested.set(block.target, Math.max(expiresAt, requested.get(block.target) ?? 0));
                    if (covering?.family === range.family && covering.first <= range.first && covering.last >= range.last) continue;
                    desired.set(block.target, expiresAt);
                    if (!this.addFailed.has(block.target)) covering = range;
                }
                for (const target of this.addFailed) if (!desired.has(target)) this.addFailed.delete(target);
                // Each kernel operation is isolated: one rejected target must not abort or wipe the rest.
                let recompute = false;
                const failures: { target: string; op: 'add' | 'remove'; error: unknown }[] = [];
                const attempt = async (op: 'add' | 'remove', target: string, fn: () => Promise<void>) => {
                    try {
                        await fn();
                        return true;
                    } catch (error) {
                        failures.push({ target, op, error });
                        return false;
                    }
                };
                const covers = (outer: AddressRange, inner: AddressRange) =>
                    outer.family === inner.family && outer.first <= inner.first && outer.last >= inner.last;
                const rangeOf = new Map<string, AddressRange>();
                const rangeFor = (target: string) => {
                    let range = rangeOf.get(target);
                    if (!range) rangeOf.set(target, (range = addressRange(target)));
                    return range;
                };
                // A mirrored entry covered by a desired target that is not yet installed is replaced inside the add loop
                // (remove, add, restore on failure) so a failed add never drops protection.
                // A newer revision accepted mid-pass makes every remaining mutation (planned from this snapshot) suspect:
                // stop, keep the mirror as it stands, and let the loop restart against the latest revision.
                const stale = () => !this.sameRevision(snapshot);
                // A newer revision that still asks for this target must not abort its install (a stream of new bans would
                // otherwise starve a covering range); only a dropped/allow-listed target is abandoned.
                const latestExpiry = (target: string) => (this.sameRevision(snapshot) ? undefined : this.requestedBy(this.current!).get(target));
                const pendingAdds = [...desired].filter(([target, expiresAt]) => this.mirror.get(target) !== expiresAt).map(([target]) => target);
                for (const target of [...this.mirror.keys()]) {
                    if (desired.has(target)) continue;
                    const range = rangeFor(target);
                    if (pendingAdds.some(outer => covers(rangeFor(outer), range))) continue;
                    if (stale()) break;
                    if (await attempt('remove', target, () => this.backend.remove(target))) this.mirror.delete(target);
                }
                const installedThisPass: AddressRange[] = [];
                for (const [target, expiresAt] of desired) {
                    if (this.mirror.get(target) === expiresAt) continue;
                    if (stale()) break;
                    const range = rangeFor(target);
                    if (installedThisPass.some(outer => covers(outer, range))) continue;
                    // Native interval sets reject overlapping elements: clear covered entries first, restore on failure.
                    const covered: [string, number][] = [];
                    // A TTL refresh replaces the installed element; if the re-add fails the old one is restored.
                    const installedExpiry = this.mirror.get(target);
                    if (installedExpiry !== undefined) {
                        if (!(await attempt('remove', target, () => this.backend.remove(target)))) continue;
                        this.mirror.delete(target);
                        covered.push([target, installedExpiry]);
                    }
                    const restore = async () => {
                        // A newer snapshot may have been accepted while this pass ran (it is queued for the next one):
                        // never resurrect an entry it dropped, and use its TTL for the ones it keeps.
                        let seen = this.current;
                        let latest = this.sameRevision(snapshot) ? undefined : this.requestedBy(seen!);
                        for (const [other, previous] of covered) {
                            // A snapshot may also arrive while an earlier restore below is awaited.
                            if (this.current !== seen) {
                                seen = this.current;
                                latest = this.sameRevision(snapshot) ? undefined : this.requestedBy(seen!);
                            }
                            const otherExpiry = latest ? latest.get(other) : previous;
                            if (otherExpiry === undefined) continue;
                            const left = otherExpiry - this.now();
                            if (left > 0 && (await attempt('add', other, () => this.backend.add(other, Math.ceil(left / 1000)))))
                                this.mirror.set(other, otherExpiry);
                        }
                    };
                    const remaining = expiresAt - this.now();
                    if (remaining <= 0) {
                        // Nothing to add; an unexpired old entry keeps its protection. Narrower targets were left out of
                        // `desired` because of this covering range, so recompute now that it is known to be expired.
                        recompute = true;
                        await restore();
                        continue;
                    }
                    let clearFailed = false;
                    for (const [other] of [...this.mirror]) {
                        if (other === target || !covers(range, rangeFor(other))) continue;
                        if (stale() && latestExpiry(target) === undefined) break;
                        // Removals can outlast the cover's TTL: once it has expired, stop clearing (the covered entries
                        // keep their protection) and let the expired-cover path below restore what was removed.
                        if ((stale() ? latestExpiry(target)! : expiresAt) <= this.now()) break;
                        if (await attempt('remove', other, () => this.backend.remove(other))) {
                            // Restore only what the current snapshot still requests, with the snapshot's TTL (not the mirror's).
                            const wanted = requested.get(other);
                            if (wanted !== undefined) covered.push([other, wanted]);
                            this.mirror.delete(other);
                        } else clearFailed = true;
                    }
                    let installExpiry = expiresAt;
                    if (stale()) {
                        // The range may have been dropped while covered entries were being removed: do not install it, and
                        // put back whatever the latest snapshot still requests. If it is still requested, install it now.
                        const latest = latestExpiry(target);
                        if (latest === undefined) {
                            await restore();
                            break;
                        }
                        installExpiry = latest;
                    }
                    // Removals above may have outlasted the deadline; never install an already-expired ban.
                    const remainingAtAdd = installExpiry - this.now();
                    if (!clearFailed && remainingAtAdd <= 0) {
                        recompute = true;
                        await restore();
                        continue;
                    }
                    // A failed clear means the kernel would reject the add as overlapping; keep existing protection.
                    if (!clearFailed && (await attempt('add', target, () => this.backend.add(target, Math.ceil(remainingAtAdd / 1000))))) {
                        this.mirror.set(target, installExpiry);
                        this.addFailed.delete(target);
                        installedThisPass.push(range);
                    } else {
                        this.addFailed.add(target);
                        await restore();
                    }
                }
                if (failures.length) {
                    // One bounded summary per pass; per-operation logging could emit thousands of lines every few seconds.
                    logger.error(
                        {
                            failed: failures.length,
                            sample: failures.slice(0, 5).map(({ target, op, error }) => ({
                                target,
                                op,
                                err: error instanceof Error ? error.message : String(error)
                            }))
                        },
                        'Firewall backend operations failed'
                    );
                    const first = failures[0].error;
                    const error = new Error(
                        failures.length === 1 && first instanceof Error
                            ? first.message
                            : `${failures.length} firewall operations failed: ${failures
                                  .map(f => f.target)
                                  .slice(0, 5)
                                  .join(', ')}`
                    );
                    if (!this.sameRevision(snapshot) || this.pending) {
                        // A newer revision (or trigger) arrived during this pass: count this failure, then apply the
                        // newer state now instead of leaving it queued until the next timer tick.
                        this.status.errors++;
                        this.status.lastError = error.message.slice(0, 256);
                        this.pending = true;
                        continue;
                    }
                    throw error;
                }
                if (stale()) {
                    // Superseded mid-pass: this snapshot is not reported applied; rerun against the latest revision.
                    this.pending = true;
                    continue;
                }
                if (recompute) {
                    // A skipped expired covering range hid narrower targets from this pass; run again before reporting applied.
                    this.pending = true;
                    continue;
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
