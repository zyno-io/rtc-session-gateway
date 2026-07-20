import type Srf from 'drachtio-srf';

import { normalizeCallId } from './call-id';

export interface ActiveCall {
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
    dialog: Srf.Dialog;
}

export type ActiveCallSnapshot = Pick<
    ActiveCall,
    | 'callId'
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
        this.releaseReservation(call.callId);
        this.calls.set(call.callId, call);
        return call;
    }

    get(callId: string) {
        return this.calls.get(callId);
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
}

export function snapshotCall(call: ActiveCall): ActiveCallSnapshot {
    const { dialog: _dialog, ...snapshot } = call;
    return snapshot;
}
