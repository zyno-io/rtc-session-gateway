import { randomUUID } from 'crypto';

const SafePathChars = /[^A-Za-z0-9._~:@+=-]+/g;

export function normalizeCallId(sipCallId: string | undefined | null) {
    const stripped = (sipCallId ?? '')
        .trim()
        .replace(/^["'<\s]+/, '')
        .replace(/[>"'\s]+$/, '')
        .replace(/^sip:/i, '')
        .replace(SafePathChars, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return stripped || `call-${randomUUID()}`;
}
