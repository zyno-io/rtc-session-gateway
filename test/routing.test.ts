import assert from 'node:assert/strict';
import test from 'node:test';

import { getSipUser, matchRoute, parseRoutesJson, stripSipUri } from '../src/routing';

test('parses valid route JSON', () => {
    const routes = parseRoutesJson(
        JSON.stringify([{ match: 'exact', value: 'support', url: 'https://example.com/sip' }])
    );
    assert.deepEqual(routes, [{ match: 'exact', value: 'support', url: 'https://example.com/sip' }]);
});

test('matches exact routes against destination user', () => {
    const route = matchRoute(
        [{ match: 'exact', value: 'support', url: 'https://example.com/sip' }],
        { destinationUri: 'sip:support@example.net', destinationUser: 'support' }
    );
    assert.equal(route?.url, 'https://example.com/sip');
});

test('matches user prefix routes', () => {
    const route = matchRoute(
        [{ match: 'userPrefix', value: 'dev-support-', url: 'https://dev.example.com/sip' }],
        { destinationUri: 'sip:dev-support-alpha@example.net', destinationUser: 'dev-support-alpha' }
    );
    assert.equal(route?.url, 'https://dev.example.com/sip');
});

test('strips name-addr wrappers and URI params', () => {
    assert.equal(stripSipUri('"Sales" <sip:support@example.net;transport=udp>'), 'sip:support@example.net');
    assert.equal(getSipUser('sip:support@example.net'), 'support');
});
