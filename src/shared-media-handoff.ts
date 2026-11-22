export const HANDOFF_HEADER = 'X-RTC-Media-Handoff';
export const HANDOFF_SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\nm=audio 0 RTP/AVP 0\r\na=inactive\r\n';
export const HANDOFF_MOVE_TIMEOUT_MS = 15000;
const tokenPattern = /^[A-Za-z0-9_.:@-]{1,192}$/;

export interface SharedMediaOffer {
    nonce: string;
    backendId: string;
    endpointId: string;
}

export function sipTarget(uri: string): string | undefined {
    const match = /^sips?:([+\w.-]{1,128})@([\w.-]{1,253})(?::\d+)?(?:;[^?\s<>]*)?$/i.exec(uri);
    return match ? `${match[1]}@${match[2].toLowerCase()}` : undefined;
}

type HandoffMessage = 'offer' | 'ready' | 'return' | 'move' | 'status' | 'result';

export function encodeHandoff(kind: HandoffMessage, fields: string[]): string {
    const payload = Buffer.from(JSON.stringify(fields)).toString('base64url');
    return `v1.${kind}.${payload}`;
}

export function readHandoff(kind: HandoffMessage, value: string | undefined, fieldCount: number): string[] | undefined {
    if (!value || value.length > 1500) return;
    const match = /^v1\.([a-z]+)\.([\w-]+)$/.exec(value);
    if (!match || match[1] !== kind) return;
    const payload = match[2];
    try {
        const fields: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (Array.isArray(fields) && fields.length === fieldCount && fields.every(field => typeof field === 'string' && field.length <= 320))
            return fields;
    } catch {
        return;
    }
}

export function readSharedOffer(header: string, requestUri: string): SharedMediaOffer | undefined {
    const fields = readHandoff('offer', header, 5);
    if (!fields) return;
    const [nonce, backendId, endpointId, target, timestamp] = fields;
    if (!tokenPattern.test(nonce) || !tokenPattern.test(backendId) || !tokenPattern.test(endpointId)) return;
    if (target !== sipTarget(requestUri) || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 45000) return;
    return { nonce, backendId, endpointId };
}

export function isHandoffToken(value: string | undefined): value is string {
    return !!value && tokenPattern.test(value);
}

export function targetSession(fields: string[] | undefined, offer: SharedMediaOffer, callId: string): string | undefined {
    if (!fields) return;
    const [nonce, endpointId, peerCallId, sessionId] = fields;
    if (nonce === offer.nonce && endpointId === offer.endpointId && peerCallId === callId && tokenPattern.test(sessionId)) return sessionId;
}
