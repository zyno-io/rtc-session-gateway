import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCallId } from '../src/call-id';

test('keeps path-safe SIP Call-IDs intact', () => {
    assert.equal(normalizeCallId('abc123@example.com'), 'abc123@example.com');
});

test('strips unsafe path characters from SIP Call-IDs', () => {
    assert.equal(normalizeCallId(' <sip:abc/123?x=1@example.com> '), 'abc-123-x=1@example.com');
});

test('generates a fallback call id for empty input', () => {
    assert.match(normalizeCallId(''), /^call-/);
});
