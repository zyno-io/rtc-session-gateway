export type SipHeaders = Record<string, string>;

export interface InviteHttpRequest {
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
    event: 'answered' | 'reinvite' | 'bye' | 'terminated';
    callId: string;
    sipCallId: string;
    headers?: SipHeaders;
    sdp?: string;
    status?: number;
    reason?: string;
    receivedAt: string;
}

export interface AnswerAction {
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

export class InvalidHttpActionError extends Error { }

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
        return { action: 'answer', sdp: data.sdp, status, headers, receiverUrl };
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
