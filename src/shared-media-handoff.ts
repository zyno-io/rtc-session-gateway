import { createHmac, timingSafeEqual } from 'node:crypto';

export const HANDOFF_HEADER = 'X-Zyno-Media-Handoff';
export const HANDOFF_SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\nm=audio 0 RTP/AVP 0\r\na=inactive\r\n';
export const HANDOFF_MOVE_TIMEOUT_MS = 15000;
const tokenPattern = /^[A-Za-z0-9_.:@-]{1,192}$/;

export interface SharedMediaOffer {
    nonce: string;
    backendId: string;
    endpointId: string;
    returnUri: string;
}

export function sipTarget(uri: string): string | undefined {
    const match = /^sips?:([+\w.-]{1,128})@([\w.-]{1,253})(?::\d+)?(?:;[^?\s<>]*)?$/i.exec(uri);
    return match ? `${match[1]}@${match[2].toLowerCase()}` : undefined;
}

export function signHandoff(secret: string, kind: 'offer' | 'ready' | 'return' | 'move' | 'status' | 'result', fields: string[]): string {
    const payload = Buffer.from(JSON.stringify(fields)).toString('base64url');
    const signature = createHmac('sha256', secret).update(`zyno-media-handoff:v1:${kind}:${payload}`).digest('base64url');
    return `v1.${payload}.${signature}`;
}

export function readHandoff(
    secret: string,
    kind: 'offer' | 'ready' | 'return' | 'move' | 'status' | 'result',
    value: string | undefined,
    fieldCount: number
): string[] | undefined {
    if (!value || value.length > 1500) return;
    const match = /^v1\.([\w-]+)\.([\w-]{43})$/.exec(value);
    if (!match) return;
    const [, payload, signature] = match;
    const expected = createHmac('sha256', secret).update(`zyno-media-handoff:v1:${kind}:${payload}`).digest('base64url');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return;
    try {
        const fields: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (Array.isArray(fields) && fields.length === fieldCount && fields.every(field => typeof field === 'string' && field.length <= 320))
            return fields;
    } catch {
        return;
    }
}

export function readSharedOffer(secret: string, header: string, requestUri: string): SharedMediaOffer | undefined {
    const fields = readHandoff(secret, 'offer', header, 6);
    if (!fields) return;
    const [nonce, backendId, endpointId, returnUri, target, timestamp] = fields;
    if (!tokenPattern.test(nonce) || !tokenPattern.test(backendId) || !tokenPattern.test(endpointId) || !sipTarget(returnUri)) return;
    if (target !== sipTarget(requestUri) || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 45000) return;
    return { nonce, backendId, endpointId, returnUri };
}

export function isHandoffToken(value: string | undefined): value is string {
    return !!value && tokenPattern.test(value);
}

export function targetSession(fields: string[] | undefined, offer: SharedMediaOffer, callId: string): string | undefined {
    if (!fields) return;
    const [nonce, endpointId, peerCallId, sessionId] = fields;
    if (nonce === offer.nonce && endpointId === offer.endpointId && peerCallId === callId && tokenPattern.test(sessionId)) return sessionId;
}
