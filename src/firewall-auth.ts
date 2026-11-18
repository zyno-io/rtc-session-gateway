import { timingSafeEqual } from 'node:crypto';

export function bearerMatches(header: string | undefined, token: string | undefined): boolean {
    if (!token) return false;
    const actual = Buffer.from(header ?? '');
    const expected = Buffer.from('Bearer ' + token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
