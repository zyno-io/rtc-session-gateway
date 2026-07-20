import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, WriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { posix as path } from 'node:path';
import { pipeline } from 'node:stream/promises';

import axios, { AxiosError } from 'axios';

import {
    CreateMediaSessionParams,
    BridgeParams,
    BridgeResult,
    GatewayMediaController,
    GatherParams,
    GatherResult,
    LeaveMessageParams,
    LeaveMessageResult,
    MediaEndpointSnapshot,
    MediaEndpointType,
    RtcIceConfiguration,
    RecordingMergeTarget,
    MediaSessionSnapshot,
    RecordingListItem,
    PlayAndGatherParams,
    PlayAndWaitParams
} from './media-controller';
import { MediaServerManager, RtpbridgeBackend } from './media-server-manager';
import { RtpbridgeClient, RtpbridgeServerInfo } from './rtpbridge-client';

interface MediaSessionRecord {
    sessionId: string;
    callId?: string;
    backendId?: string;
    iceConfiguration?: RtcIceConfiguration;
    ownerConnectionId?: string;
    createdAt: string;
    updatedAt: string;
    client: RtpbridgeClient;
    endpoints: Map<string, MediaEndpointSnapshot>;
}

interface MediaEventPublisher {
    sendEvent(connectionId: string, event: { event: string; sessionId?: string; data?: unknown }): boolean;
}

interface RecordingMetadata {
    sessionId: string;
    backendId?: string;
    filePath: string;
    recordingPath: string;
    downloadPath: string;
}

interface ActiveEndpointAction {
    name: string;
    cancel: () => void;
}

export class MediaSessionNotFoundError extends Error { }
export class MediaEndpointNotFoundError extends Error { }
export class MediaUnavailableError extends Error { }
export class MediaActionConflictError extends Error { }
export class MediaRecordingProxyError extends Error {
    constructor(
        public statusCode: number,
        message: string
    ) {
        super(message);
    }
}

const PCAP_HEADER_BYTES = 24;
const MAX_RECORDING_MERGE_TARGETS = 1000;

export class MediaSessionService implements GatewayMediaController {
    private sessions = new Map<string, MediaSessionRecord>();
    private endpointToSession = new Map<string, string>();
    private recordings = new Map<string, RecordingMetadata>();
    private pendingIceRestarts = new Map<string, Promise<{ sdpOffer: string; offerGeneration: number }>>();
    private activeEndpointActions = new Map<string, ActiveEndpointAction>();
    private sensitiveGatherEndpointIds = new Set<string>();

    constructor(
        private mediaServers: MediaServerManager,
        private recordingsPath = '/var/lib/rtpbridge/recordings',
        private eventPublisher?: MediaEventPublisher,
        private recordingHttpTimeoutMs = 10_000,
        private turnConfig?: { authSecret?: string; credentialTtlSeconds: number }
    ) { }

    list(): MediaSessionSnapshot[] {
        return [...this.sessions.values()].map(snapshotSession);
    }

    get(sessionId: string) {
        const session = this.sessions.get(sessionId);
        return session ? snapshotSession(session) : undefined;
    }

    async createSession(params?: CreateMediaSessionParams) {
        const client = await this.mediaServers.createClient({ callId: params?.callId });
        let sessionId: string | undefined;
        try {
            sessionId = await client.createSession();
            const iceConfiguration = await this.createIceConfiguration(client, sessionId);
            const now = new Date().toISOString();
            const record: MediaSessionRecord = {
                sessionId,
                callId: params?.callId,
                backendId: client.backendId,
                iceConfiguration,
                ownerConnectionId: params?.ownerConnectionId,
                createdAt: now,
                updatedAt: now,
                client,
                endpoints: new Map()
            };
            this.sessions.set(sessionId, record);
            client.onClose(() => this.dropSession(sessionId!));
            client.on('rtpbridge.event', event => this.publishRtpbridgeEvent(record, event));
            return snapshotSession(record);
        } catch (err) {
            if (sessionId) await client.destroySession(sessionId).catch(() => undefined);
            client.close();
            if (params?.callId) this.mediaServers.unregisterCall(params.callId, client.backendId);
            throw err;
        }
    }

    async destroySession(sessionId: string) {
        const session = this.requireSession(sessionId);
        try {
            await session.client.destroySession(sessionId);
        } finally {
            session.client.close();
            this.dropSession(sessionId);
        }
    }

    async createWebrtcOffer(sessionId: string, params: { direction?: string } = {}) {
        const session = this.requireSession(sessionId);
        const result = await session.client.createWebrtcOffer(sessionId, params);
        this.addEndpoint(session, result.endpointId, 'webrtc', params.direction);
        return result;
    }

    async createWebrtcFromOffer(sessionId: string, params: { sdp: string; direction?: string }) {
        const session = this.requireSession(sessionId);
        const result = await session.client.createWebrtcFromOffer(sessionId, params);
        this.addEndpoint(session, result.endpointId, 'webrtc', params.direction);
        return result;
    }

    async acceptWebrtcAnswer(endpointId: string, params: { sdp: string; offerGeneration?: number }) {
        const session = this.requireSessionForEndpoint(endpointId);
        await session.client.acceptWebrtcAnswer(endpointId, params.sdp, params.offerGeneration);
        this.pendingIceRestarts.delete(endpointId);
        return { ok: true as const };
    }

    async acceptWebrtcOffer(endpointId: string, params: { sdp: string }) {
        const session = this.requireSessionForEndpoint(endpointId);
        return session.client.acceptWebrtcOffer(endpointId, params.sdp);
    }

    async restartIce(endpointId: string) {
        const session = this.requireSessionForEndpoint(endpointId);
        let pending = this.pendingIceRestarts.get(endpointId);
        if (!pending) {
            pending = session.client.iceRestart(endpointId).catch(err => {
                this.pendingIceRestarts.delete(endpointId);
                throw err;
            });
            this.pendingIceRestarts.set(endpointId, pending);
        }
        const result = await pending;
        session.iceConfiguration = await this.createIceConfiguration(session.client, session.sessionId);
        this.touch(session);
        return {
            ...result,
            ...(session.iceConfiguration ? { iceConfiguration: session.iceConfiguration } : {})
        };
    }

    private async createIceConfiguration(client: RtpbridgeClient, sessionId: string): Promise<RtcIceConfiguration | undefined> {
        const secret = this.turnConfig?.authSecret;
        if (!secret) return undefined;

        const serverInfo = await client.getServerInfo();
        const mediaIp = selectCoturnIpv4(serverInfo.mediaIp);
        if (!mediaIp) {
            throw new MediaUnavailableError('rtpbridge server.info returned no usable IPv4 media_ip for cohosted coturn');
        }

        const backendId = client.backendId ?? client.backendHost ?? mediaIp;
        const expiresAtSeconds = Math.floor(Date.now() / 1000) + this.turnConfig!.credentialTtlSeconds;
        const username = `${expiresAtSeconds}:rtc-session-${sessionId}`;
        const credential = createHmac('sha1', secret).update(username).digest('base64');
        const tlsHostname = `ip-${mediaIp.replaceAll('.', '-')}.zynoinfra.net`;
        return {
            backendId,
            mediaIp,
            expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
            servers: [
                { urls: [`stun:${mediaIp}:3478`] },
                {
                    urls: [
                        `turn:${mediaIp}:3478?transport=udp`,
                        `turn:${mediaIp}:3478?transport=tcp`,
                        `turns:${tlsHostname}:443?transport=tcp`
                    ],
                    username,
                    credential
                }
            ]
        };
    }

    async createRtpOffer(sessionId: string, params: { direction?: string; srtp?: boolean; codecs?: string[] } = {}) {
        const session = this.requireSession(sessionId);
        const result = await session.client.createRtpOffer(sessionId, params);
        this.addEndpoint(session, result.endpointId, 'rtp', params.direction);
        return result;
    }

    async createRtpFromOffer(sessionId: string, params: { sdp: string; direction?: string }) {
        const session = this.requireSession(sessionId);
        const result = await session.client.createRtpFromOffer(sessionId, params);
        this.addEndpoint(session, result.endpointId, 'rtp', params.direction);
        return result;
    }

    async acceptRtpAnswer(endpointId: string, params: { sdp: string }) {
        const session = this.requireSessionForEndpoint(endpointId);
        await session.client.acceptRtpAnswer(endpointId, params.sdp);
        return { ok: true as const };
    }

    async rtpReinvite(endpointId: string, params: { sdp: string }) {
        const session = this.requireSessionForEndpoint(endpointId);
        return session.client.rtpReinvite(endpointId, params.sdp);
    }

    async play(sessionId: string, params: { source: string; loopCount?: number | null; cacheTtlSecs?: number; headers?: Record<string, string> }) {
        const session = this.requireSession(sessionId);
        const result = await session.client.createFileEndpoint(sessionId, params);
        this.addEndpoint(session, result.endpointId, 'file');
        return result;
    }

    async stopMedia(endpointId: string) {
        const session = this.requireSessionForEndpoint(endpointId);
        this.cancelEndpointAction(endpointId);
        await this.removeTrackedEndpoint(session, endpointId);
        return { ok: true as const };
    }

    async updateDirection(endpointId: string, direction: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive') {
        const session = this.requireSessionForEndpoint(endpointId);
        await session.client.updateDirection(endpointId, direction);
        const endpoint = session.endpoints.get(endpointId);
        if (endpoint) endpoint.direction = direction;
        this.touch(session);
        return { ok: true as const };
    }

    async bridge(sessionId: string, params: BridgeParams): Promise<BridgeResult> {
        const session = this.requireSession(sessionId);
        const target = this.requireSession(params.targetSessionId);
        const direction = params.direction ?? 'sendrecv';
        if (session.sessionId === target.sessionId) {
            throw new MediaActionConflictError('Cannot bridge a media session to itself');
        }
        if (session.backendId !== target.backendId) {
            throw new MediaActionConflictError('Cannot bridge media sessions on different rtpbridge backends');
        }

        const result = await session.client.bridgeSession(params.targetSessionId, { direction });
        const currentSession = this.sessions.get(sessionId);
        const currentTarget = this.sessions.get(params.targetSessionId);
        if (currentSession !== session || currentTarget !== target) {
            await session.client.removeEndpoint(result.endpointId).catch(() => undefined);
            throw new MediaSessionNotFoundError('Media session was destroyed while bridge was being created');
        }

        this.addEndpoint(session, result.endpointId, 'bridge', direction, {
            pairedSessionId: target.sessionId,
            pairedEndpointId: result.targetEndpointId
        });
        this.addEndpoint(target, result.targetEndpointId, 'bridge', direction, {
            pairedSessionId: session.sessionId,
            pairedEndpointId: result.endpointId
        });
        return {
            sessionId,
            endpointId: result.endpointId,
            targetSessionId: params.targetSessionId,
            targetEndpointId: result.targetEndpointId
        };
    }

    async unbridge(endpointId: string) {
        const session = this.requireSessionForEndpoint(endpointId);
        const endpoint = session.endpoints.get(endpointId);
        if (endpoint?.type !== 'bridge') {
            throw new MediaActionConflictError(`Media endpoint ${endpointId} is not a bridge endpoint`);
        }
        await this.removeTrackedEndpoint(session, endpointId);
        return { ok: true as const };
    }

    async gather(sessionId: string, params: GatherParams) {
        const session = this.requireEndpointInSession(sessionId, params.endpointId);
        return this.collectDtmf(session, params);
    }

    async playAndGather(sessionId: string, params: PlayAndGatherParams) {
        const session = this.requireEndpointInSession(sessionId, params.endpointId);
        let playbackEndpointId: string | undefined;
        let playbackStopped = false;
        if (params.sensitive) this.sensitiveGatherEndpointIds.add(params.endpointId);

        const stopPlayback = async () => {
            if (!playbackEndpointId || playbackStopped) return;
            playbackStopped = true;
            await this.removeTrackedEndpoint(session, playbackEndpointId).catch(() => undefined);
        };

        try {
            const playback = await session.client.createFileEndpoint(sessionId, {
                source: params.source,
                loopCount: params.loopCount,
                cacheTtlSecs: params.cacheTtlSecs,
                headers: params.headers
            });
            playbackEndpointId = playback.endpointId;
            this.addEndpoint(session, playbackEndpointId, 'file');

            const result = await this.collectDtmf(session, params, {
                onFirstDigit: params.stopPlaybackOnDigit === false ? undefined : stopPlayback
            });
            return { ...result, playbackEndpointId };
        } finally {
            await stopPlayback();
            if (params.sensitive) queueMicrotask(() => this.sensitiveGatherEndpointIds.delete(params.endpointId));
        }
    }

    async playAndWait(sessionId: string, params: PlayAndWaitParams) {
        const session = this.requireSession(sessionId);
        const played = await this.playToCompletion(session, params.source, params.playbackTimeoutMs ?? 120_000);
        return { played };
    }

    async leaveMessage(sessionId: string, params: LeaveMessageParams): Promise<LeaveMessageResult> {
        const session = this.requireEndpointInSession(sessionId, params.endpointId);
        const abort = new AbortController();
        const release = this.claimEndpointAction(params.endpointId, 'leave-message', () => abort.abort());
        let vadStopped = false;
        const stopVad = async () => {
            if (vadStopped) return;
            vadStopped = true;
            await session.client.stopVad(params.endpointId).catch(() => undefined);
        };

        try {
            await session.client.startVad(params.endpointId, {
                silenceIntervalMs: params.silenceIntervalMs,
                speechThreshold: params.speechThreshold
            });
            const terminator = await this.waitForLeaveMessageTerminator(session, params, abort.signal);
            await stopVad();

            const messageSource = params.messageSource;
            if (terminator === 'silence' && messageSource) {
                const messagePlayed = await this.playToCompletion(
                    session,
                    messageSource,
                    positiveIntegerOrDefault(params.playbackTimeoutMs, 30_000)!,
                    abort.signal
                );
                return messagePlayed
                    ? { terminator, messagePlayed: true }
                    : { terminator: 'cancelled', messagePlayed: false };
            }
            return { terminator, messagePlayed: false };
        } finally {
            await stopVad();
            release();
        }
    }

    async injectDtmf(endpointId: string, digit: string) {
        if (!/^[0-9A-D#*]$/i.test(digit)) throw new MediaRecordingProxyError(400, 'digit must be one DTMF character');
        const session = this.requireSessionForEndpoint(endpointId);
        await session.client.injectDtmf(endpointId, digit.toUpperCase());
        return { ok: true as const };
    }

    async startRecording(sessionId: string, params: { endpointId?: string; filePath?: string; recordOutbound?: boolean }) {
        const session = this.requireSession(sessionId);
        const filePath = this.recordingFilePath(params.filePath, sessionId);
        const result = await session.client.startRecording(sessionId, {
            endpointId: params.endpointId,
            filePath,
            recordOutbound: params.recordOutbound
        });
        const metadata = this.recordingMetadata(session, filePath);
        this.recordings.set(result.recordingId, { sessionId, ...metadata });
        return { ...result, ...metadata };
    }

    async destroySessionsForOwner(ownerConnectionId: string) {
        const owned = [...this.sessions.values()].filter(session => session.ownerConnectionId === ownerConnectionId);
        for (const session of owned) this.dropSession(session.sessionId);
        await Promise.allSettled(
            owned.map(async session => {
                try {
                    await session.client.destroySession(session.sessionId);
                } finally {
                    session.client.close();
                }
            })
        );
    }

    async stopRecording(recordingId: string) {
        const metadata = this.recordings.get(recordingId);
        if (!metadata) throw new MediaEndpointNotFoundError(`Recording ${recordingId} not found`);
        const session = this.requireSession(metadata.sessionId);
        const result = await session.client.stopRecording(recordingId);
        this.recordings.delete(recordingId);
        return { ...result, ...this.recordingMetadata(session, result.filePath || metadata.filePath) };
    }

    async listRecordings(params: { backendId?: string; startsWith?: string; skip?: number; limit?: number } = {}) {
        const skip = Math.max(0, params.skip ?? 0);
        const limit = Math.min(Math.max(1, params.limit ?? 100), 1000);
        const backends = params.backendId ? [await this.mediaServers.resolveBackend(params.backendId)] : await this.mediaServers.resolveBackends();

        const byBackend = await Promise.all(backends.map(async backend => this.listBackendRecordings(backend, params.startsWith)));
        const all = byBackend.flat().sort((a, b) => `${a.backendId}/${a.path}`.localeCompare(`${b.backendId}/${b.path}`));
        return {
            recordings: all.slice(skip, skip + limit),
            total: all.length,
            skip,
            limit
        };
    }

    async downloadRecording(backendId: string, recordingPath: string) {
        const backend = await this.mediaServers.resolveBackend(backendId);
        try {
            const response = await axios.get(this.recordingUrl(backend, recordingPath), {
                responseType: 'stream',
                timeout: this.recordingHttpTimeoutMs,
                validateStatus: () => true
            });
            return {
                status: response.status,
                headers: response.headers,
                stream: response.data as NodeJS.ReadableStream
            };
        } catch (err) {
            if (err instanceof MediaRecordingProxyError) throw err;
            throw recordingProxyError(err, 'rtpbridge recording download failed');
        }
    }

    async mergeRecordings(targets: RecordingMergeTarget[]) {
        if (!Array.isArray(targets) || targets.length === 0) {
            throw new MediaRecordingProxyError(400, 'recording merge requires at least one target');
        }
        if (targets.length > MAX_RECORDING_MERGE_TARGETS) {
            throw new MediaRecordingProxyError(400, `recording merge supports at most ${MAX_RECORDING_MERGE_TARGETS} targets`);
        }

        const tempDir = await mkdtemp(path.join(tmpdir(), 'rtc-session-gateway-recording-merge-'));
        try {
            const sourcePaths: string[] = [];
            for (const [index, target] of targets.entries()) {
                const backend = await this.mediaServers.resolveBackend(target.backendId);
                const sourcePath = path.join(tempDir, `${index + 1}.pcap`);
                await this.downloadRecordingToFile(backend, target.path, sourcePath);
                sourcePaths.push(sourcePath);
            }

            const outputPath = path.join(tempDir, 'merged.pcap');
            await mergePcapFiles(sourcePaths, outputPath);
            const outputStat = await stat(outputPath);

            return {
                status: 200,
                headers: {
                    'content-type': 'application/vnd.tcpdump.pcap',
                    'content-length': outputStat.size,
                    'cache-control': 'no-store'
                },
                stream: createCleanupReadStream(outputPath, tempDir)
            };
        } catch (err) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
            if (err instanceof MediaRecordingProxyError) throw err;
            throw recordingProxyError(err, 'rtpbridge recording merge failed');
        }
    }

    async deleteRecording(backendId: string, recordingPath: string) {
        const backend = await this.mediaServers.resolveBackend(backendId);
        try {
            const response = await axios.delete(this.recordingUrl(backend, recordingPath), {
                timeout: this.recordingHttpTimeoutMs,
                validateStatus: () => true
            });
            if (response.status >= 200 && response.status < 300) return { deleted: true as const };
            throw new MediaRecordingProxyError(response.status, response.data?.error ?? `rtpbridge recording delete failed with ${response.status}`);
        } catch (err) {
            if (err instanceof MediaRecordingProxyError) throw err;
            throw recordingProxyError(err, 'rtpbridge recording delete failed');
        }
    }

    private requireSession(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new MediaSessionNotFoundError(`Media session ${sessionId} not found`);
        return session;
    }

    private requireSessionForEndpoint(endpointId: string) {
        const sessionId = this.endpointToSession.get(endpointId);
        if (!sessionId) throw new MediaEndpointNotFoundError(`Media endpoint ${endpointId} not found`);
        return this.requireSession(sessionId);
    }

    private requireEndpointInSession(sessionId: string, endpointId: string) {
        const session = this.requireSession(sessionId);
        const endpointSessionId = this.endpointToSession.get(endpointId);
        if (endpointSessionId !== sessionId || !session.endpoints.has(endpointId)) {
            throw new MediaEndpointNotFoundError(`Media endpoint ${endpointId} not found in session ${sessionId}`);
        }
        return session;
    }

    private addEndpoint(
        session: MediaSessionRecord,
        endpointId: string,
        type: MediaEndpointType,
        direction?: string,
        bridge?: { pairedSessionId?: string; pairedEndpointId?: string }
    ) {
        const now = new Date().toISOString();
        session.endpoints.set(endpointId, { endpointId, type, direction, ...bridge, createdAt: now });
        this.endpointToSession.set(endpointId, session.sessionId);
        this.touch(session);
    }

    private touch(session: MediaSessionRecord) {
        session.updatedAt = new Date().toISOString();
    }

    private dropSession(sessionId: string) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.cancelSessionActions(session);
        this.dropPairedBridgeEndpoints(session);
        this.sessions.delete(sessionId);
        for (const endpointId of session.endpoints.keys()) this.endpointToSession.delete(endpointId);
        for (const endpointId of session.endpoints.keys()) this.pendingIceRestarts.delete(endpointId);
        for (const [recordingId, metadata] of this.recordings) {
            if (metadata.sessionId === sessionId) this.recordings.delete(recordingId);
        }
        if (session.callId) this.mediaServers.unregisterCall(session.callId, session.backendId);
    }

    private async collectDtmf(
        session: MediaSessionRecord,
        params: GatherParams,
        hooks: { onFirstDigit?: () => Promise<void> | void } = {}
    ): Promise<GatherResult> {
        const numDigits = positiveIntegerOrDefault(params.numDigits, undefined);
        const timeoutMs = positiveIntegerOrDefault(params.timeoutMs, 5_000)!;
        const interDigitTimeoutMs = positiveIntegerOrDefault(params.interDigitTimeoutMs, timeoutMs)!;
        const terminator = params.terminator ?? '#';
        let cancel: () => void = () => undefined;
        const release = this.claimEndpointAction(params.endpointId, 'gather', () => cancel());
        if (params.sensitive) this.sensitiveGatherEndpointIds.add(params.endpointId);

        return new Promise<GatherResult>(resolve => {
            let digits = '';
            let timer: NodeJS.Timeout | undefined;
            let finished = false;
            let firstDigit = true;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                session.client.removeListener('dtmf', onDtmf);
                release();
                if (params.sensitive) {
                    queueMicrotask(() => this.sensitiveGatherEndpointIds.delete(params.endpointId));
                }
            };

            const finish = (reason: GatherResult['reason']) => {
                if (finished) return;
                finished = true;
                cleanup();
                resolve({ digits, reason });
            };

            const armTimer = (delayMs: number) => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => finish('timeout'), delayMs);
            };

            const onDtmf = (event: { endpointId?: string; digit?: string }) => {
                if (event.endpointId !== params.endpointId || !event.digit) return;
                const digit = event.digit.toUpperCase();
                if (terminator.includes(digit)) {
                    finish('terminator');
                    return;
                }

                digits += digit;
                if (firstDigit) {
                    firstDigit = false;
                    void hooks.onFirstDigit?.();
                }
                if (numDigits && digits.length >= numDigits) {
                    finish('digits');
                    return;
                }
                armTimer(interDigitTimeoutMs);
            };

            cancel = () => finish('cancelled');
            session.client.on('dtmf', onDtmf);
            armTimer(timeoutMs);
        });
    }

    private async waitForLeaveMessageTerminator(
        session: MediaSessionRecord,
        params: LeaveMessageParams,
        signal: AbortSignal
    ): Promise<LeaveMessageResult['terminator']> {
        const maxDurationMs = positiveIntegerOrDefault(params.maxWaitMs, 60_000)!;
        const terminator = params.terminator ?? '#';

        return new Promise(resolve => {
            let resolved = false;
            const done = (reason: LeaveMessageResult['terminator']) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolve(reason);
            };
            const maxTimer = setTimeout(() => done('max-duration'), maxDurationMs);
            const onSilence = (event?: { endpointId?: string }) => {
                if (event?.endpointId && event.endpointId !== params.endpointId) return;
                done('silence');
            };
            const onDtmf = (event: { endpointId?: string; digit?: string }) => {
                if (event.endpointId === params.endpointId && event.digit && terminator.includes(event.digit.toUpperCase())) {
                    done('dtmf');
                }
            };
            const cleanup = () => {
                clearTimeout(maxTimer);
                session.client.removeListener('vad.silence', onSilence);
                session.client.removeListener('dtmf', onDtmf);
                signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => done('cancelled');

            session.client.on('vad.silence', onSilence);
            session.client.on('dtmf', onDtmf);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) done('cancelled');
        });
    }

    private async playToCompletion(session: MediaSessionRecord, source: string, timeoutMs: number, signal?: AbortSignal) {
        const playback = await session.client.createFileEndpoint(session.sessionId, { source });
        this.addEndpoint(session, playback.endpointId, 'file');
        try {
            if (signal?.aborted) return false;
            return await new Promise<boolean>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    cleanup();
                    reject(new Error(`Media playback timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                const onFinished = (event: { endpointId?: string; reason?: string; error?: string }) => {
                    if (event.endpointId !== playback.endpointId) return;
                    cleanup();
                    if (event.reason === 'error' || event.error) {
                        reject(new Error(`Media playback failed: ${event.error ?? 'unknown error'}`));
                    } else {
                        resolve(true);
                    }
                };
                const onAbort = () => {
                    cleanup();
                    resolve(false);
                };
                const cleanup = () => {
                    clearTimeout(timeout);
                    session.client.removeListener('endpoint.file.finished', onFinished);
                    signal?.removeEventListener('abort', onAbort);
                };
                session.client.on('endpoint.file.finished', onFinished);
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted) onAbort();
            });
        } finally {
            await this.removeTrackedEndpoint(session, playback.endpointId).catch(() => undefined);
        }
    }

    private async playTone(session: MediaSessionRecord, tone: string, durationMs: number) {
        const playback = await session.client.createToneEndpoint(session.sessionId, { tone, durationMs });
        this.addEndpoint(session, playback.endpointId, 'tone');
        try {
            await new Promise(resolve => setTimeout(resolve, durationMs + 100));
        } finally {
            await this.removeTrackedEndpoint(session, playback.endpointId).catch(() => undefined);
        }
    }

    private async removeTrackedEndpoint(session: MediaSessionRecord, endpointId: string) {
        const endpoint = session.endpoints.get(endpointId);
        await session.client.removeEndpoint(endpointId);
        this.removeEndpointSnapshot(session, endpointId);
        if (endpoint?.type === 'bridge') this.removePairedBridgeEndpoint(endpoint);
    }

    private removeEndpointSnapshot(session: MediaSessionRecord, endpointId: string) {
        session.endpoints.delete(endpointId);
        this.endpointToSession.delete(endpointId);
        this.pendingIceRestarts.delete(endpointId);
        this.activeEndpointActions.delete(endpointId);
        this.touch(session);
    }

    private removePairedBridgeEndpoint(endpoint: MediaEndpointSnapshot) {
        if (!endpoint.pairedSessionId || !endpoint.pairedEndpointId) return;
        const pairedSession = this.sessions.get(endpoint.pairedSessionId);
        if (!pairedSession) return;
        this.removeEndpointSnapshot(pairedSession, endpoint.pairedEndpointId);
    }

    private dropPairedBridgeEndpoints(session: MediaSessionRecord) {
        for (const endpoint of session.endpoints.values()) {
            if (endpoint.type === 'bridge') this.removePairedBridgeEndpoint(endpoint);
        }
    }

    private claimEndpointAction(endpointId: string, action: string, cancel: () => void = () => undefined) {
        const active = this.activeEndpointActions.get(endpointId);
        if (active) throw new MediaActionConflictError(`Endpoint ${endpointId} already has active ${active.name}`);
        const record = { name: action, cancel };
        this.activeEndpointActions.set(endpointId, record);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (this.activeEndpointActions.get(endpointId) === record) this.activeEndpointActions.delete(endpointId);
        };
    }

    private cancelEndpointAction(endpointId: string) {
        this.activeEndpointActions.get(endpointId)?.cancel();
    }

    private cancelSessionActions(session: MediaSessionRecord) {
        for (const endpointId of session.endpoints.keys()) this.cancelEndpointAction(endpointId);
    }

    private publishRtpbridgeEvent(session: MediaSessionRecord, event: unknown) {
        if (!session.ownerConnectionId || !this.eventPublisher) return;
        if (isSensitiveDtmfEvent(event, this.sensitiveGatherEndpointIds)) return;
        this.eventPublisher.sendEvent(session.ownerConnectionId, {
            event: 'media.rtpbridge',
            sessionId: session.sessionId,
            data: event
        });
    }

    private recordingMetadata(session: MediaSessionRecord, filePath: string) {
        const recordingPath = this.relativeRecordingPath(filePath);
        return {
            backendId: session.backendId,
            filePath,
            recordingPath,
            downloadPath: session.backendId ? `/recordings/${encodeURIComponent(session.backendId)}/${encodeRecordingPath(recordingPath)}` : ''
        };
    }

    private relativeRecordingPath(filePath: string) {
        const root = this.recordingsRootPath();
        const normalized = filePath.replace(/\\/g, '/');
        if (path.isAbsolute(normalized)) {
            const relative = path.relative(root, normalized);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
        }
        return normalized.replace(/^\/+/, '');
    }

    private recordingFilePath(requestedPath: string | undefined, sessionId: string) {
        const root = this.recordingsRootPath();
        const requested = (requestedPath ?? `${sessionId}-${randomUUID()}.pcap`).replace(/\\/g, '/');
        const resolved = path.resolve(root, requested);
        const relative = path.relative(root, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new MediaRecordingProxyError(400, 'recording filePath must be inside configured recordings path');
        }
        return resolved;
    }

    private recordingsRootPath() {
        return path.resolve(this.recordingsPath.replace(/\\/g, '/').replace(/\/+$/, '') || '/');
    }

    private async listBackendRecordings(backend: RtpbridgeBackend, startsWith?: string): Promise<RecordingListItem[]> {
        const recordings: RecordingListItem[] = [];
        const pageLimit = 1000;
        let skip = 0;
        let total: number | undefined;

        do {
            const url = new URL('/recordings', ensureTrailingSlash(backend.httpUrl));
            if (startsWith) url.searchParams.set('startsWith', startsWith);
            url.searchParams.set('skip', String(skip));
            url.searchParams.set('limit', String(pageLimit));

            try {
                const response = await axios.get<{ recordings?: string[]; total?: number }>(url.toString(), {
                    timeout: this.recordingHttpTimeoutMs
                });
                const page = response.data.recordings ?? [];
                total = typeof response.data.total === 'number' ? response.data.total : undefined;
                recordings.push(...page.map(recordingPath => ({
                    backendId: backend.id,
                    path: recordingPath
                })));
                if (page.length === 0 || page.length < pageLimit) break;
                skip += page.length;
            } catch (err) {
                throw recordingProxyError(err, 'rtpbridge recording list failed');
            }
        } while (total === undefined || skip < total);

        return recordings;
    }

    private recordingUrl(backend: RtpbridgeBackend, recordingPath: string) {
        return new URL(`/recordings/${encodeRecordingPath(recordingPath)}`, ensureTrailingSlash(backend.httpUrl)).toString();
    }

    private async downloadRecordingToFile(backend: RtpbridgeBackend, recordingPath: string, destinationPath: string) {
        let response;
        try {
            response = await axios.get(this.recordingUrl(backend, recordingPath), {
                responseType: 'stream',
                timeout: this.recordingHttpTimeoutMs,
                validateStatus: () => true
            });
        } catch (err) {
            throw recordingProxyError(err, 'rtpbridge recording download failed');
        }

        if (response.status < 200 || response.status >= 300) {
            destroyStream(response.data);
            throw new MediaRecordingProxyError(response.status, `rtpbridge recording download failed with ${response.status}`);
        }

        try {
            await pipeline(response.data as NodeJS.ReadableStream, createWriteStream(destinationPath));
        } catch (err) {
            throw recordingProxyError(err, 'rtpbridge recording download failed');
        }
    }
}

function isSensitiveDtmfEvent(event: unknown, sensitiveEndpointIds: Set<string>) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const message = event as { event?: unknown; data?: unknown };
    if (message.event !== 'dtmf' || !message.data || typeof message.data !== 'object' || Array.isArray(message.data)) return false;
    const endpointId = (message.data as { endpointId?: unknown }).endpointId;
    return typeof endpointId === 'string' && sensitiveEndpointIds.has(endpointId);
}

function selectCoturnIpv4(mediaIp: RtpbridgeServerInfo['mediaIp']): string | undefined {
    const candidates = Array.isArray(mediaIp) ? mediaIp : [mediaIp];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (isIP(trimmed) === 4) return trimmed;
    }
    return undefined;
}

function snapshotSession(session: MediaSessionRecord): MediaSessionSnapshot {
    return {
        sessionId: session.sessionId,
        callId: session.callId,
        backendId: session.backendId,
        ...(session.iceConfiguration ? { iceConfiguration: session.iceConfiguration } : {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        endpoints: [...session.endpoints.values()]
    };
}

function encodeRecordingPath(recordingPath: string) {
    return safeRecordingPathSegments(recordingPath)
        .map(segment => encodeURIComponent(segment))
        .join('/');
}

function safeRecordingPathSegments(recordingPath: string) {
    const segments = recordingPath
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map(segment => {
            let decoded: string;
            try {
                decoded = decodeURIComponent(segment);
            } catch {
                throw new MediaRecordingProxyError(400, 'Invalid recording path');
            }
            if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
                throw new MediaRecordingProxyError(400, 'Invalid recording path');
            }
            return decoded;
        });

    if (!segments.length) throw new MediaRecordingProxyError(400, 'Invalid recording path');
    return segments;
}

async function mergePcapFiles(segmentPaths: string[], outputPath: string) {
    if (!segmentPaths.length) throw new MediaRecordingProxyError(400, 'No PCAP segments to merge');

    const firstHeader = await readPcapHeader(segmentPaths[0]);
    const output = createWriteStream(outputPath);
    try {
        output.write(firstHeader);
        for (const segmentPath of segmentPaths) {
            const header = await readPcapHeader(segmentPath);
            if (!header.equals(firstHeader)) {
                throw new MediaRecordingProxyError(422, 'PCAP segments have incompatible headers');
            }
            await appendFileRange(output, segmentPath, PCAP_HEADER_BYTES);
        }
    } catch (err) {
        output.destroy();
        throw err;
    }

    output.end();
    await once(output, 'close');
}

async function readPcapHeader(filePath: string) {
    const file = await open(filePath, 'r');
    try {
        const header = Buffer.alloc(PCAP_HEADER_BYTES);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead !== header.length) throw new MediaRecordingProxyError(422, 'Invalid PCAP segment');
        return header;
    } finally {
        await file.close();
    }
}

async function appendFileRange(output: WriteStream, filePath: string, start: number) {
    const input = createReadStream(filePath, { start });
    try {
        for await (const chunk of input) {
            if (!output.write(chunk)) await once(output, 'drain');
        }
    } finally {
        input.destroy();
    }
}

function createCleanupReadStream(filePath: string, tempDir: string) {
    const stream = createReadStream(filePath);
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    };
    stream.once('close', cleanup);
    stream.once('error', cleanup);
    return stream;
}

function destroyStream(stream: unknown) {
    if (stream && typeof (stream as any).destroy === 'function') {
        (stream as any).destroy();
    }
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number | undefined) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) throw new MediaRecordingProxyError(400, 'media action timing and count values must be positive integers');
    return value;
}

function recordingProxyError(err: unknown, fallbackMessage: string) {
    if (err instanceof AxiosError) {
        if (err.response) {
            return new MediaRecordingProxyError(err.response.status, err.response.data?.error ?? fallbackMessage);
        }
        if (err.code === 'ECONNABORTED') {
            return new MediaRecordingProxyError(504, `${fallbackMessage}: timeout`);
        }
    }
    return new MediaRecordingProxyError(502, fallbackMessage);
}

function ensureTrailingSlash(url: string) {
    return url.endsWith('/') ? url : `${url}/`;
}
