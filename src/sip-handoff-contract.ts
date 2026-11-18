/** Public SIP handoff contracts. Consumers generate their contract copy from this file. */
export type SipCallOwnership = 'application' | 'transferring' | 'handed-off' | 'returning';

export interface SipTransferParams {
    sessionId: string;
    mediaSessionId: string;
    requestUri: string;
    transferId: string;
    headers?: Record<string, string>;
    callingNumber?: string;
    callingName?: string;
    proxy?: string;
    auth?: { username: string; password: string };
}

export interface FinalizedSipRecording {
    recordingId: string;
    backendId?: string;
    filePath: string;
    recordingPath: string;
    downloadPath: string;
    durationMs: number;
    packets: number;
}

export interface SipTransferStatus {
    transferId: string;
    logicalCallId: string;
    state: 'transferring' | 'completed' | 'failed';
    startedAt: string;
    committedAt?: string;
    destinationSipCallId?: string;
    recordings: FinalizedSipRecording[];
    failure?: string;
}

export interface SipReturnMetadata {
    logicalCallId: string;
    returning?: boolean;
    previousSessionId?: string;
}

export function isSipTransferStatus(value: unknown): value is SipTransferStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as Record<string, unknown>;
    return (
        typeof status.transferId === 'string' &&
        !!status.transferId &&
        typeof status.logicalCallId === 'string' &&
        !!status.logicalCallId &&
        ['transferring', 'completed', 'failed'].includes(String(status.state)) &&
        typeof status.startedAt === 'string' &&
        Number.isFinite(Date.parse(status.startedAt)) &&
        (status.committedAt === undefined || (typeof status.committedAt === 'string' && Number.isFinite(Date.parse(status.committedAt)))) &&
        (status.state !== 'completed' || typeof status.committedAt === 'string') &&
        (status.destinationSipCallId === undefined || typeof status.destinationSipCallId === 'string') &&
        (status.failure === undefined || typeof status.failure === 'string') &&
        Array.isArray(status.recordings) &&
        status.recordings.every(
            recording =>
                recording &&
                typeof recording === 'object' &&
                typeof recording.recordingId === 'string' &&
                typeof recording.filePath === 'string' &&
                typeof recording.recordingPath === 'string' &&
                typeof recording.downloadPath === 'string' &&
                (recording.backendId === undefined || typeof recording.backendId === 'string') &&
                Number.isFinite(recording.durationMs) &&
                recording.durationMs >= 0 &&
                Number.isSafeInteger(recording.packets) &&
                recording.packets >= 0
        )
    );
}
