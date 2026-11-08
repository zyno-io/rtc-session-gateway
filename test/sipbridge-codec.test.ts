import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeSipbridgeFrame, encodeSipbridgeFrame } from '../src/sipbridge/codec';
import { Envelope } from '../src/sipbridge/generated/sipbridge-control';
import { NativeOperationError } from '../src/sipbridge-signaling';
import { controlErrorForCommand } from '../src/session-commands';
const cases = JSON.parse(readFileSync('dependencies/sipbridge-json-cases.json', 'utf8')) as {
    name: string;
    valid: boolean;
    json: string;
}[];
for (const fixture of cases)
    test('canonical native JSON: ' + fixture.name, () => {
        if (!fixture.valid) assert.throws(() => decodeSipbridgeFrame(fixture.json));
        else {
            const value = decodeSipbridgeFrame(fixture.json);
            assert.deepEqual(decodeSipbridgeFrame(encodeSipbridgeFrame(value)), value);
        }
    });
test('native JSON preserves bigint and opaque bytes across encode/decode', () => {
    const envelope = Envelope.fromJSON({
        correlationId: 'test',
        write: { wire: 'AP+AQQ==', bindingRevision: '9007199254740993' }
    });
    assert.deepEqual(decodeSipbridgeFrame(encodeSipbridgeFrame(envelope)), envelope);
    assert.throws(() => decodeSipbridgeFrame(new Uint8Array([0xff])));
    assert.throws(() => decodeSipbridgeFrame('{"correlationId":"x","ping":{"nonce":"x"}}', 10));
});
test('native uncertainty is exposed distinctly from unavailable signaling', () => {
    assert.equal(controlErrorForCommand(new NativeOperationError('unknown', true)).code, 'SIGNALING_UNKNOWN');
    assert.equal(controlErrorForCommand(new NativeOperationError('offline', false, true)).code, 'SIGNALING_UNAVAILABLE');
});

test('a lost command reply fences the context and does not replay the mutation', async () => {
    const { SipbridgeSignaling } = await import('../src/sipbridge-signaling');
    const { loadConfig } = await import('../src/config');
    const signaling = new SipbridgeSignaling(loadConfig({}));
    let writes = 0;
    const state = {
        peer: {
            client: {
                async request() {
                    writes++;
                    throw new Error('connection reset after write');
                }
            }
        },
        snapshot: {},
        sequence: 0n,
        tail: Promise.resolve(),
        uncertain: false,
        ended: false
    };
    const action = { $case: 'cancel', cancel: {} } as const;
    await assert.rejects(signaling.command(state as never, action), error => error instanceof NativeOperationError && error.uncertain);
    await assert.rejects(signaling.command(state as never, action), error => error instanceof NativeOperationError && error.uncertain);
    assert.equal(writes, 1);
});
test('an unavailable session does not consume a command sequence or mark its outcome unknown', async () => {
    const { SipbridgeSignaling } = await import('../src/sipbridge-signaling');
    const { loadConfig } = await import('../src/config');
    const signaling = new SipbridgeSignaling(loadConfig({}));
    const state = {
        peer: {},
        snapshot: {},
        sequence: 4n,
        tail: Promise.resolve(),
        uncertain: false,
        ended: false
    };
    await assert.rejects(
        signaling.command(state as never, { $case: 'cancel', cancel: {} }),
        error => error instanceof NativeOperationError && !error.uncertain && error.unavailable
    );
    assert.equal(state.sequence, 4n);
    assert.equal(state.uncertain, false);
});
