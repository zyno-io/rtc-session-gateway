import type { SipHandoffAnswer, SipReturnMetadata, SipTransferStatus } from './sip-handoff-contract';

export type SipHeaders = Record<string, string>;

export interface InviteHttpRequest extends Partial<SipReturnMetadata> {
    event: 'invite';
    callId: string;
    sipCallId: string;
    destinationUri: string;
    destinationUser?: string;
    sourceUri?: string;
    from?: string;
    to?: string;
    contact?: string;
    headers: SipHeaders;
    sdp?: string;
    receivedAt: string;
}

export interface FollowUpHttpEvent {
    event: 'answered' | 'reinvite' | 'bye' | 'terminated' | 'transferred';
    callId: string;
    sipCallId: string;
    headers?: SipHeaders;
    sdp?: string;
    status?: number;
    reason?: string;
    /** Set on a return attempt's `answered` and `terminated` events; matches the invite's `returnAttemptId`. */
    returnAttemptId?: string;
    transfer?: SipTransferStatus;
    receivedAt: string;
}

export interface AnswerAction extends SipHandoffAnswer {
    action: 'answer';
    sdp: string;
    status?: number;
    headers?: SipHeaders;
    receiverUrl?: string;
}

export interface RejectAction {
    action: 'reject';
    status: number;
    reason?: string;
    headers?: SipHeaders;
    receiverUrl?: string;
}

export type SipAction = AnswerAction | RejectAction;

export class InvalidHttpActionError extends Error {}

export function parseSipActionResponse(input: unknown, options?: { allowReceiverUrl?: boolean }): SipAction {
    if (!input || typeof input !== 'object') {
        throw new InvalidHttpActionError('HTTP response must be an object');
    }

    const data = input as Record<string, unknown>;
    const headers = parseOptionalHeaders(data.headers);
    const receiverUrl = parseOptionalReceiverUrl(data.receiverUrl, !!options?.allowReceiverUrl);

    if (data.action === 'answer') {
        if (typeof data.sdp !== 'string' || !data.sdp.trim()) {
            throw new InvalidHttpActionError('answer action requires non-empty sdp');
        }

        const status = parseOptionalStatus(data.status, 200, 200, 'answer status');
        const sharedMediaSessionId = data.sharedMediaSessionId;
        if (sharedMediaSessionId !== undefined && (typeof sharedMediaSessionId !== 'string' || !sharedMediaSessionId.trim())) {
            throw new InvalidHttpActionError('Invalid sharedMediaSessionId');
        }
        if (data.fixedCarrierMedia !== undefined && typeof data.fixedCarrierMedia !== 'boolean')
            throw new InvalidHttpActionError('Invalid fixedCarrierMedia');
        return {
            action: 'answer',
            sdp: data.sdp,
            status,
            headers,
            receiverUrl,
            ...(sharedMediaSessionId ? { sharedMediaSessionId } : {}),
            ...(data.fixedCarrierMedia ? { fixedCarrierMedia: true } : {})
        };
    }

    if (data.action === 'reject') {
        const status = parseRequiredStatus(data.status, 300, 699, 'reject status');
        const reason = typeof data.reason === 'string' ? data.reason : undefined;
        return { action: 'reject', status, reason, headers, receiverUrl };
    }

    throw new InvalidHttpActionError('action must be "answer" or "reject"');
}

export function parseOptionalHeaders(input: unknown): SipHeaders | undefined {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new InvalidHttpActionError('headers must be an object');
    }

    const headers: SipHeaders = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'string') {
            throw new InvalidHttpActionError(`header ${key} must be a string`);
        }
        headers[key] = value;
    }
    return headers;
}

/** Compares canonical receiver URLs, ignoring fragments because HTTP requests omit them. */
export function sameReceiverUrl(a: string, b: string): boolean {
    if (a === b) return true;
    try {
        const first = new URL(a);
        const second = new URL(b);
        first.hash = '';
        second.hash = '';
        return first.href === second.href;
    } catch {
        return false;
    }
}

function parseOptionalReceiverUrl(input: unknown, allowReceiverUrl: boolean) {
    if (input === undefined || input === null) return undefined;
    if (!allowReceiverUrl) throw new InvalidHttpActionError('receiverUrl is not accepted for this response');
    if (typeof input !== 'string' || !input.trim()) throw new InvalidHttpActionError('receiverUrl must be a URL');
    new URL(input);
    return input;
}

function parseOptionalStatus(input: unknown, min: number, max: number, name: string) {
    if (input === undefined || input === null) return undefined;
    return parseRequiredStatus(input, min, max, name);
}

function parseRequiredStatus(input: unknown, min: number, max: number, name: string) {
    if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
        throw new InvalidHttpActionError(`${name} must be an integer between ${min} and ${max}`);
    }
    return input;
}

/** Transfer IDs are retained for the life of a call: a small byte limit and a conservative character set bound that memory. */
export const TRANSFER_ID_MAX_BYTES = 128;
export function isValidTransferId(value: string) {
    return /^[A-Za-z0-9._:-]+$/.test(value) && Buffer.byteLength(value, 'utf8') <= TRANSFER_ID_MAX_BYTES;
}
export const TRANSFER_ID_ERROR = `transferId must be 1-${TRANSFER_ID_MAX_BYTES} bytes of [A-Za-z0-9._:-]`;
