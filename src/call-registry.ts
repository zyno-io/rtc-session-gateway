import { randomUUID } from 'node:crypto';

import type { NativeDialog } from './sipbridge-signaling';

import { normalizeCallId } from './call-id';
import type { SipCallOwnership, SipTransferStatus } from './sip-handoff-contract';
import type { ReplacesIdentity } from './sip-sdp';

export interface ActiveCall {
    logicalCallId?: string;
    ownership?: SipCallOwnership;
    transfer?: SipTransferStatus;
    /** Bounded record of earlier finished transfers (oldest first), so a delayed retry of an old transferId never dials again. */
    finishedTransfers?: SipTransferStatus[];
    /** Every transfer ID admitted on this call (bounded); a retried ID whose result was evicted is refused, never dialed. */
    admittedTransferIds?: Set<string>;
    /** Destination dialog of a handed-off call; the primary `dialog` stays the original leg. */
    peerDialog?: NativeDialog;
    /** Observed source IP of `dialog` (inbound legs) and, when only the configured destination is known, its host. */
    remoteAddress?: string;
    remoteHost?: string;
    /** Same for `peerDialog`; an outbound leg has no observed source, so its configured destination host is the fallback. */
    peerAddress?: string;
    peerHost?: string;
    /** Addresses the destination host resolved to when the handoff committed. */
    peerAddresses?: string[];
    callId: string;
    sipCallId: string;
    routeUrl: string;
    receiverUrl: string;
    controlConnectionId?: string;
    destinationUri: string;
    destinationUser?: string;
    sourceUri?: string;
    localSdp?: string;
    remoteSdp?: string;
    createdAt: string;
    updatedAt: string;
    dialog: NativeDialog;
}

export type ActiveCallSnapshot = Pick<
    ActiveCall,
    | 'callId'
    | 'logicalCallId'
    | 'ownership'
    | 'transfer'
    | 'sipCallId'
    | 'routeUrl'
    | 'receiverUrl'
    | 'controlConnectionId'
    | 'destinationUri'
    | 'destinationUser'
    | 'sourceUri'
    | 'localSdp'
    | 'remoteSdp'
    | 'createdAt'
    | 'updatedAt'
>;

export class CallRegistry {
    private calls = new Map<string, ActiveCall>();
    private reservations = new Set<string>();

    reserveCallId(sipCallId: string) {
        const base = normalizeCallId(sipCallId);
        let candidate = base;
        let suffix = 2;

        while (this.calls.has(candidate) || this.reservations.has(candidate)) {
            candidate = `${base}-${suffix++}`;
        }

        this.reservations.add(candidate);
        return candidate;
    }

    releaseReservation(callId: string) {
        this.reservations.delete(callId);
    }

    activate(call: ActiveCall) {
        call.logicalCallId ??= randomUUID();
        call.ownership ??= 'application';
        this.releaseReservation(call.callId);
        this.calls.set(call.callId, call);
        return call;
    }

    get(callId: string) {
        return this.calls.get(callId);
    }

    /** Finds a live dialog by exact Call-ID and tags; `toTag` is this gateway's tag, `fromTag` the remote's. */
    findDialog(identity: ReplacesIdentity) {
        for (const call of this.calls.values()) {
            for (const dialog of [call.dialog, call.peerDialog]) {
                if (
                    dialog &&
                    !dialog.isEnded &&
                    dialog.sipCallId === identity.callId &&
                    dialog.localTag === identity.toTag &&
                    dialog.remoteTag === identity.fromTag
                )
                    return { call, dialog };
            }
        }
        return undefined;
    }

    list() {
        return [...this.calls.values()].map(snapshotCall);
    }

    remove(callId: string) {
        const call = this.calls.get(callId);
        if (!call) return undefined;
        this.calls.delete(callId);
        return call;
    }

    updateSdp(callId: string, sdp: { localSdp?: string; remoteSdp?: string }) {
        const call = this.calls.get(callId);
        if (!call) return undefined;
        call.localSdp = sdp.localSdp ?? call.localSdp;
        call.remoteSdp = sdp.remoteSdp ?? call.remoteSdp;
        call.updatedAt = new Date().toISOString();
        return call;
    }

    get size() {
        return this.calls.size;
    }

    get pendingCount() {
        return this.reservations.size;
    }

    hasCallOrReservation(callId: string) {
        return this.calls.has(callId) || this.reservations.has(callId);
    }
}

export function snapshotCall(call: ActiveCall): ActiveCallSnapshot {
    const {
        dialog: _dialog,
        peerDialog: _peerDialog,
        remoteAddress: _remoteAddress,
        remoteHost: _remoteHost,
        peerAddress: _peerAddress,
        peerHost: _peerHost,
        peerAddresses: _peerAddresses,
        finishedTransfers: _finishedTransfers,
        admittedTransferIds: _admittedTransferIds,
        ...snapshot
    } = call;
    return snapshot;
}
