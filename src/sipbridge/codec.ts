import type { Envelope as EnvelopeMessage, ProcessRef, StateAuthority } from './generated/sipbridge-control';

import { Envelope } from './generated/sipbridge-control';
import { parseSipbridgeJson, validateSipbridgeJson } from './json-validation';

export const SIPBRIDGE_SUBPROTOCOL = 'sipbridge.control.json.v1';
export const SIPBRIDGE_MAX_ENVELOPE_BYTES = 1024 * 1024;
export const SIPBRIDGE_CAPABILITY = 'sip.v1';
export const SIPBRIDGE_STAGING_CAPABILITY = SIPBRIDGE_CAPABILITY;
export const SIPBRIDGE_CONTINUITY_CAPABILITY = 'sip.dialog-continuity.v1';
export const SIPBRIDGE_STATE_CAPABILITY = 'sip.state.v1';
export const SIPBRIDGE_DIRECTORY_RECONCILE_CAPABILITY = 'sip.directory-reconcile.v1';
export const SIPBRIDGE_COMPLETION_RELAY_CAPABILITY = 'sip.completion-relay.v1';
export const SIPBRIDGE_NATIVE_COMPLETION_CAPABILITY = 'sip.native-completion.v1';
export const SIPBRIDGE_COMMAND_BUDGET_CAPABILITY = 'sip.command-budget.v1';
export const SIPBRIDGE_COMMAND_ADMISSION_CAPABILITY = 'sip.command-admission.v1';
export const SIPBRIDGE_LOCAL_CHALLENGE_CAPABILITY = 'sip.local-challenge.v1';
export const SIPBRIDGE_COMMAND_BUDGET_MS = 40_000;
export const SIPBRIDGE_CONTROL_BUDGET_MS = 2000;
export const sipbridgeOperationBudget = (payload: EnvelopeMessage['payload']): number =>
    payload?.$case === 'command' ? SIPBRIDGE_COMMAND_BUDGET_MS : SIPBRIDGE_CONTROL_BUDGET_MS;
export const hasSipbridgeStateCapability = (capabilities: readonly string[] | undefined): boolean =>
    Boolean(capabilities?.includes(SIPBRIDGE_STATE_CAPABILITY));
const reference = /^[A-Za-z0-9_.:@+-]{1,96}$/;

export function isSipbridgeReference(value: string): boolean {
    return reference.exec(value)?.[0] === value;
}

export function isSipbridgeProcess(value: ProcessRef | undefined): value is ProcessRef {
    return value !== undefined && isSipbridgeReference(value.instanceId) && isSipbridgeReference(value.epoch);
}

export function isSipbridgeStateAuthority(value: StateAuthority | undefined): value is StateAuthority {
    return Boolean(
        value &&
        isSipbridgeReference(value.service) &&
        isSipbridgeReference(value.generation) &&
        isSipbridgeReference(value.primaryId) &&
        Number.isSafeInteger(value.schemaVersion) &&
        value.schemaVersion > 0
    );
}

export function decodeSipbridgeFrame(data: Uint8Array | string, bound = SIPBRIDGE_MAX_ENVELOPE_BYTES): EnvelopeMessage {
    if (!Number.isInteger(bound) || bound < 1 || bound > SIPBRIDGE_MAX_ENVELOPE_BYTES) throw new Error('invalid sipbridge frame bound');
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
    if (size === 0 || size > bound) throw new Error('invalid sipbridge frame size');
    const value = parseSipbridgeJson(data);
    validateSipbridgeJson(value);
    const envelope = Envelope.fromJSON(value);
    if (
        !isSipbridgeReference(envelope.correlationId) ||
        !envelope.payload ||
        envelope.remainingBudgetMs > sipbridgeOperationBudget(envelope.payload)
    ) {
        throw new Error('invalid sipbridge control envelope');
    }
    if (envelope.sessionId && !isSipbridgeReference(envelope.sessionId)) throw new Error('invalid sipbridge session ID');
    return envelope;
}

export function encodeSipbridgeFrame(envelope: EnvelopeMessage, bound = SIPBRIDGE_MAX_ENVELOPE_BYTES): string {
    const value = Envelope.toJSON(envelope);
    validateSipbridgeJson(value);
    const data = JSON.stringify(value);
    decodeSipbridgeFrame(data, bound);
    return data;
}
