export type MediaEndpointType = 'webrtc' | 'rtp' | 'file' | 'tone' | 'websocket' | 'bridge';

export interface MediaEndpointSnapshot {
    endpointId: string;
    type: MediaEndpointType;
    direction?: string;
    pairedSessionId?: string;
    pairedEndpointId?: string;
    createdAt: string;
}

export interface RtpOfferOptions {
    direction?: string;
    srtp?: boolean;
    srtpOptional?: boolean;
    codecs?: string[];
}

export interface RtcIceServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface RtcIceConfiguration {
    backendId: string;
    mediaIp: string;
    expiresAt: string;
    servers: RtcIceServer[];
}

export interface MediaSessionSnapshot {
    sessionId: string;
    callId?: string;
    backendId?: string;
    iceConfiguration?: RtcIceConfiguration;
    createdAt: string;
    updatedAt: string;
    endpoints: MediaEndpointSnapshot[];
}

export interface RecordingListItem {
    backendId: string;
    path: string;
}

export interface RecordingListResult {
    recordings: RecordingListItem[];
    total: number;
    skip: number;
    limit: number;
}

export interface RecordingDownloadResult {
    status: number;
    headers: Record<string, unknown>;
    stream: NodeJS.ReadableStream;
}

export interface RecordingMergeTarget {
    backendId: string;
    path: string;
}

export interface GatherParams {
    endpointId: string;
    numDigits?: number;
    timeoutMs?: number;
    interDigitTimeoutMs?: number;
    terminator?: string;
    sensitive?: boolean;
}

export interface GatherResult {
    digits: string;
    reason: 'digits' | 'terminator' | 'timeout' | 'cancelled';
}

export interface PlayAndGatherParams extends GatherParams {
    source: string;
    loopCount?: number | null;
    cacheTtlSecs?: number;
    headers?: Record<string, string>;
    stopPlaybackOnDigit?: boolean;
    postPlaybackTimeoutMs?: number;
}

export interface PlayAndWaitParams {
    source: string;
    playbackTimeoutMs?: number;
}

export interface LeaveMessageParams {
    endpointId: string;
    messageSource?: string;
    maxWaitMs?: number;
    playbackTimeoutMs?: number;
    silenceIntervalMs?: number;
    speechThreshold?: number;
    terminator?: string;
}

export interface LeaveMessageResult {
    terminator: 'silence' | 'max-duration' | 'dtmf' | 'cancelled';
    messagePlayed: boolean;
}

export interface BridgeParams {
    targetSessionId: string;
    direction?: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive';
}

export interface BridgeResult {
    sessionId: string;
    endpointId: string;
    targetSessionId: string;
    targetEndpointId: string;
}

export interface CreateMediaSessionParams {
    callId?: string;
    ownerConnectionId?: string;
}

export interface GatewayMediaController {
    list(): MediaSessionSnapshot[];
    get(sessionId: string): MediaSessionSnapshot | undefined;
    createSession(params?: CreateMediaSessionParams): Promise<MediaSessionSnapshot>;
    destroySession(sessionId: string): Promise<void>;
    createWebrtcOffer(sessionId: string, params?: { direction?: string }): Promise<{ endpointId: string; sdpOffer: string }>;
    createWebrtcFromOffer(sessionId: string, params: { sdp: string; direction?: string }): Promise<{ endpointId: string; sdpAnswer: string }>;
    acceptWebrtcAnswer(endpointId: string, params: { sdp: string; offerGeneration?: number }): Promise<{ ok: true }>;
    acceptWebrtcOffer(endpointId: string, params: { sdp: string }): Promise<{ sdpAnswer: string }>;
    restartIce(endpointId: string): Promise<{ sdpOffer: string; offerGeneration: number; iceConfiguration?: RtcIceConfiguration }>;
    createRtpOffer(sessionId: string, params?: RtpOfferOptions): Promise<{ endpointId: string; sdpOffer: string }>;
    createRtpFromOffer(sessionId: string, params: { sdp: string; direction?: string }): Promise<{ endpointId: string; sdpAnswer: string }>;
    acceptRtpAnswer(endpointId: string, params: { sdp: string }): Promise<{ ok: true }>;
    rtpReinvite(endpointId: string, params: { sdp: string }): Promise<{ sdpAnswer: string }>;
    play(sessionId: string, params: { source: string; loopCount?: number | null; cacheTtlSecs?: number; headers?: Record<string, string> }): Promise<{ endpointId: string }>;
    playAndWait(sessionId: string, params: PlayAndWaitParams): Promise<{ played: boolean }>;
    stopMedia(endpointId: string): Promise<{ ok: true }>;
    updateDirection(endpointId: string, direction: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive'): Promise<{ ok: true }>;
    bridge(sessionId: string, params: BridgeParams): Promise<BridgeResult>;
    unbridge(endpointId: string): Promise<{ ok: true }>;
    gather(sessionId: string, params: GatherParams): Promise<GatherResult>;
    playAndGather(sessionId: string, params: PlayAndGatherParams): Promise<GatherResult & { playbackEndpointId?: string }>;
    leaveMessage(sessionId: string, params: LeaveMessageParams): Promise<LeaveMessageResult>;
    injectDtmf(endpointId: string, digit: string): Promise<{ ok: true }>;
    startRecording(sessionId: string, params: { endpointId?: string; filePath?: string; recordOutbound?: boolean }): Promise<{ recordingId: string; backendId?: string; filePath: string; recordingPath: string; downloadPath: string }>;
    stopRecording(recordingId: string): Promise<{ filePath: string; durationMs: number; packets: number; backendId?: string; recordingPath: string; downloadPath: string }>;
    listRecordings(params?: { backendId?: string; startsWith?: string; skip?: number; limit?: number }): Promise<RecordingListResult>;
    downloadRecording(backendId: string, recordingPath: string): Promise<RecordingDownloadResult>;
    mergeRecordings(targets: RecordingMergeTarget[]): Promise<RecordingDownloadResult>;
    deleteRecording(backendId: string, recordingPath: string): Promise<{ deleted: true }>;
}
