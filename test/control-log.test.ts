import assert from 'node:assert/strict';
import test from 'node:test';

import {
    scrubControlError,
    scrubControlRequest,
    scrubControlResponse,
    scrubRtpbridgeEvent,
    scrubRtpbridgeRequest,
    scrubRtpbridgeResponse
} from '../src/control-log';

const CARD = '4111111111111111';
const PASSWORD = 'turn-password-secret';
const SRTP_KEY = 'inline:super-secret-srtp-key';

function serialized(value: unknown) {
    return JSON.stringify(value);
}

function assertSecretsAbsent(output: string) {
    assert.ok(!output.includes(CARD));
    assert.ok(!output.includes(PASSWORD));
    assert.ok(!output.includes(SRTP_KEY));
}

test('control request keeps signaling structure without secrets', () => {
    const output = serialized(
        scrubControlRequest({
            id: 'request-1',
            method: 'sip.createOutbound',
            params: {
                requestUri: `sips:${CARD}@carrier.example.test`,
                sdp: `v=0\r\nm=audio 10000 RTP/SAVP 0\r\na=ice-pwd:${PASSWORD}\r\na=crypto:1 suite ${SRTP_KEY}\r\n`,
                headers: { Authorization: PASSWORD, 'X-Card': CARD },
                auth: { username: CARD, password: PASSWORD },
                futureSecret: CARD
            }
        })
    );
    assertSecretsAbsent(output);
    assert.match(output, /carrier\.example\.test/);
    assert.match(output, /authorization/);
    assert.match(output, /futureSecret/);
    assert.match(output, /candidateCount/);
});

test('sensitive gather response uses a tilde for every digit', () => {
    const output = serialized(
        scrubControlResponse(
            {
                id: 'request-2',
                ok: true,
                result: { digits: CARD, terminatedBy: '#' }
            },
            { method: 'media.playAndGather', sensitive: true }
        )
    );
    assert.ok(!output.includes(CARD));
    assert.ok(output.includes('~'.repeat(CARD.length)));
});

test('normal DTMF remains visible while sensitive DTMF is redacted', () => {
    const normal = serialized(scrubRtpbridgeEvent('dtmf', { digit: '5', sensitive: false }));
    const sensitive = serialized(scrubRtpbridgeEvent('dtmf', { digit: '12#', sensitive: true }));
    const unexpectedlyLong = serialized(scrubRtpbridgeEvent('dtmf', { digit: CARD, sensitive: false }));
    assert.match(normal, /"digit":"5"/);
    assert.ok(!sensitive.includes('12#'));
    assert.match(sensitive, /"digit":"~~~"/);
    assert.ok(!unexpectedlyLong.includes(CARD));
    assert.ok(unexpectedlyLong.includes('~'.repeat(CARD.length)));
});

test('rtpbridge request and response scrub SDP, tokens, paths, and errors', () => {
    const request = serialized(
        scrubRtpbridgeRequest('request-3', 'endpoint.rtp.create_from_offer', {
            sdp: `v=0\r\na=ice-pwd:${PASSWORD}\r\na=crypto:1 suite ${SRTP_KEY}`,
            creditCard: CARD
        })
    );
    const response = serialized(
        scrubRtpbridgeResponse('request-3', 'endpoint.create_websocket', {
            result: { connect_token: PASSWORD, file_path: `/recordings/${CARD}.pcap` }
        })
    );
    const error = serialized(
        scrubRtpbridgeResponse('request-3', 'future.method', {
            error: { code: 'INVALID_PARAMS', message: `card ${CARD} password ${PASSWORD}` }
        })
    );
    assertSecretsAbsent(request + response + error);
    assert.match(error, /INVALID_PARAMS/);
});

test('unknown methods expose field shape but no values', () => {
    const output = serialized(
        scrubControlRequest({
            id: 'request-4',
            method: 'future.method',
            params: { state: CARD, password: PASSWORD, nested: { sdp: SRTP_KEY }, [CARD]: PASSWORD }
        })
    );
    assertSecretsAbsent(output);
    assert.match(output, /redacted/);
    assert.match(output, /nested/);
});

test('error summaries preserve diagnostics without copying the message', () => {
    const error = Object.assign(new Error(`Sip non-success response: 488; card ${CARD}; password ${PASSWORD}`), {
        code: 'CONFLICT',
        name: PASSWORD
    });
    const output = serialized(scrubControlError(error));
    assertSecretsAbsent(output);
    assert.match(output, /CONFLICT/);
    assert.match(output, /488/);
    assert.match(output, /messageBytes/);
});
