import { CallRegistry } from './call-registry';
import { CallNotFoundError, type SipAuthCredentials } from './drachtio-gateway';
import type { GatewayController } from './http-server';
import { InvalidHttpActionError, parseOptionalHeaders } from './http-contract';
import type { GatewayMediaController } from './media-controller';
import { MediaBackendNotFoundError } from './media-server-manager';
import { MediaActionConflictError, MediaEndpointNotFoundError, MediaRecordingProxyError, MediaSessionNotFoundError, MediaUnavailableError } from './media-session-service';

export class CommandValidationError extends Error { }
export class CommandNotImplementedError extends Error { }

export interface CommandContext {
    controlConnectionId?: string;
}

export class SessionCommandHandler {
    constructor(
        private registry: CallRegistry,
        private gateway: GatewayController,
        private media?: GatewayMediaController
    ) { }

    async execute(method: string, params: unknown, context: CommandContext = {}) {
        switch (method) {
            case 'session.list':
                return { sessions: [...this.registry.list(), ...(this.media?.list() ?? [])] };
            case 'session.get':
                return this.getSession(params);
            case 'session.delete':
                return this.deleteSession(params);
            case 'session.create':
                return this.createMediaSession(params, context);
            case 'sip.createOutbound':
                return this.createOutbound(params, context);
            case 'sip.cancelOutbound':
                return this.cancelOutbound(params, context);
            case 'sip.reinvite':
                return this.reinvite(params);
            case 'sip.bye':
                return this.bye(params);
            case 'webrtc.createOffer':
                return this.createWebrtcOffer(params);
            case 'webrtc.createFromOffer':
                return this.createWebrtcFromOffer(params);
            case 'webrtc.acceptAnswer':
                return this.acceptWebrtcAnswer(params);
            case 'webrtc.acceptOffer':
                return this.acceptWebrtcOffer(params);
            case 'webrtc.restartIce':
                return this.restartIce(params);
            case 'rtp.createOffer':
                return this.createRtpOffer(params);
            case 'rtp.createFromOffer':
                return this.createRtpFromOffer(params);
            case 'rtp.acceptAnswer':
                return this.acceptRtpAnswer(params);
            case 'rtp.reinvite':
                return this.rtpReinvite(params);
            case 'media.play':
                return this.play(params);
            case 'media.stop':
                return this.stopMedia(params);
            case 'endpoint.updateDirection':
                return this.updateDirection(params);
            case 'media.bridge':
                return this.bridge(params);
            case 'media.unbridge':
                return this.unbridge(params);
            case 'media.gather':
                return this.gather(params);
            case 'media.playAndGather':
                return this.playAndGather(params);
            case 'media.leaveMessage':
                return this.leaveMessage(params);
            case 'dtmf.inject':
                return this.injectDtmf(params);
            case 'recording.start':
                return this.startRecording(params);
            case 'recording.stop':
                return this.stopRecording(params);
            case 'recording.list':
                return this.listRecordings(params);
            case 'recording.delete':
                return this.deleteRecording(params);
            case 'event.ack':
                return { ok: true };
            case 'sip.answer':
            case 'sip.reject':
                throw new CommandNotImplementedError(`${method} is not implemented in this gateway slice yet`);
            case 'vad.start':
            case 'vad.stop':
            case 'amd.start':
            case 'amd.stop':
                throw new CommandNotImplementedError(`${method} is intentionally deferred`);
            default:
                throw new CommandValidationError(`Unknown method ${method}`);
        }
    }

    private getSession(params: unknown) {
        const { sessionId } = requireObject(params);
        if (typeof sessionId !== 'string' || !sessionId.trim()) {
            throw new CommandValidationError('sessionId is required');
        }
        const call = this.registry.get(sessionId);
        if (call) {
            const { dialog: _dialog, ...snapshot } = call;
            return snapshot;
        }
        const mediaSession = this.media?.get(sessionId);
        if (mediaSession) return mediaSession;
        throw new CallNotFoundError(`Session ${sessionId} not found`);
    }

    private async deleteSession(params: unknown) {
        const { sessionId, reason, headers } = requireObject(params);
        if (typeof sessionId !== 'string' || !sessionId.trim()) {
            throw new CommandValidationError('sessionId is required');
        }
        if (this.media?.get(sessionId)) {
            await this.media.destroySession(sessionId);
            return { ok: true };
        }
        await this.gateway.bye(
            sessionId,
            typeof reason === 'string' ? reason : undefined,
            parseOptionalHeaders(headers)
        );
        return { ok: true };
    }

    private async createMediaSession(params: unknown, context: CommandContext) {
        const body = optionalObject(params);
        const callId = optionalString(body.callId, 'callId');
        return this.requireMedia().createSession({ callId, ownerConnectionId: context.controlConnectionId });
    }

    private async createOutbound(params: unknown, context: CommandContext) {
        const body = requireObject(params);
        const receiverUrl = optionalString(body.receiverUrl, 'receiverUrl');
        if (!context.controlConnectionId && !receiverUrl) {
            throw new CommandValidationError('receiverUrl is required when sip.createOutbound is not sent over the control WebSocket');
        }

        const auth = parseOptionalSipAuth(body.auth);
        const outboundAttemptId = optionalString(body.outboundAttemptId, 'outboundAttemptId');
        return this.gateway.createOutbound({
            requestUri: requiredString(body.requestUri, 'requestUri'),
            sdp: requiredString(body.sdp, 'sdp'),
            headers: parseOptionalHeaders(body.headers),
            receiverUrl,
            controlConnectionId: context.controlConnectionId,
            callingNumber: optionalString(body.callingNumber, 'callingNumber'),
            callingName: optionalString(body.callingName, 'callingName'),
            proxy: optionalString(body.proxy, 'proxy'),
            ...(outboundAttemptId ? { outboundAttemptId } : {}),
            ...(auth ? { auth } : {})
        });
    }

    private async cancelOutbound(params: unknown, context: CommandContext) {
        if (!this.gateway.cancelOutbound) throw new CommandNotImplementedError('sip.cancelOutbound is not implemented');
        const body = requireObject(params);
        return this.gateway.cancelOutbound(requiredString(body.outboundAttemptId, 'outboundAttemptId'), context.controlConnectionId);
    }

    private async reinvite(params: unknown) {
        const { sessionId, callId, sdp, headers } = requireObject(params);
        const id = typeof sessionId === 'string' ? sessionId : callId;
        if (typeof id !== 'string' || !id.trim()) throw new CommandValidationError('sessionId is required');
        if (typeof sdp !== 'string' || !sdp.trim()) throw new CommandValidationError('sdp is required');
        return this.gateway.reinvite(id, sdp, parseOptionalHeaders(headers));
    }

    private async bye(params: unknown) {
        const { sessionId, callId, reason, headers } = requireObject(params);
        const id = typeof sessionId === 'string' ? sessionId : callId;
        if (typeof id !== 'string' || !id.trim()) throw new CommandValidationError('sessionId is required');
        await this.gateway.bye(
            id,
            typeof reason === 'string' ? reason : undefined,
            parseOptionalHeaders(headers)
        );
        return { ok: true };
    }

    private async createWebrtcOffer(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().createWebrtcOffer(requiredString(body.sessionId, 'sessionId'), {
            direction: optionalString(body.direction, 'direction')
        });
    }

    private async createWebrtcFromOffer(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().createWebrtcFromOffer(requiredString(body.sessionId, 'sessionId'), {
            sdp: requiredString(body.sdp, 'sdp'),
            direction: optionalString(body.direction, 'direction')
        });
    }

    private async acceptWebrtcAnswer(params: unknown) {
        const body = requireObject(params);
        const offerGeneration = body.offerGeneration;
        if (offerGeneration !== undefined && (!Number.isInteger(offerGeneration) || (offerGeneration as number) < 0)) {
            throw new CommandValidationError('offerGeneration must be a non-negative integer');
        }
        return this.requireMedia().acceptWebrtcAnswer(requiredString(body.endpointId, 'endpointId'), {
            sdp: requiredString(body.sdp, 'sdp'),
            offerGeneration: offerGeneration as number | undefined
        });
    }

    private async acceptWebrtcOffer(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().acceptWebrtcOffer(requiredString(body.endpointId, 'endpointId'), {
            sdp: requiredString(body.sdp, 'sdp')
        });
    }

    private async restartIce(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().restartIce(requiredString(body.endpointId, 'endpointId'));
    }

    private async createRtpOffer(params: unknown) {
        const body = requireObject(params);
        const codecs = body.codecs;
        if (codecs !== undefined && (!Array.isArray(codecs) || codecs.some(codec => typeof codec !== 'string' || !codec.trim()))) {
            throw new CommandValidationError('codecs must be an array of strings');
        }
        return this.requireMedia().createRtpOffer(requiredString(body.sessionId, 'sessionId'), {
            direction: optionalString(body.direction, 'direction'),
            srtp: optionalBoolean(body.srtp, 'srtp'),
            codecs: codecs as string[] | undefined
        });
    }

    private async createRtpFromOffer(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().createRtpFromOffer(requiredString(body.sessionId, 'sessionId'), {
            sdp: requiredString(body.sdp, 'sdp'),
            direction: optionalString(body.direction, 'direction')
        });
    }

    private async acceptRtpAnswer(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().acceptRtpAnswer(requiredString(body.endpointId, 'endpointId'), {
            sdp: requiredString(body.sdp, 'sdp')
        });
    }

    private async rtpReinvite(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().rtpReinvite(requiredString(body.endpointId, 'endpointId'), {
            sdp: requiredString(body.sdp, 'sdp')
        });
    }

    private async play(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().play(requiredString(body.sessionId, 'sessionId'), {
            source: requiredString(body.source, 'source'),
            loopCount: optionalNullableInteger(body.loopCount, 'loopCount'),
            cacheTtlSecs: optionalInteger(body.cacheTtlSecs, 'cacheTtlSecs'),
            headers: parseOptionalHeaders(body.headers)
        });
    }

    private async stopMedia(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().stopMedia(requiredString(body.endpointId, 'endpointId'));
    }

    private async updateDirection(params: unknown) {
        const body = requireObject(params);
        const direction = requiredDirection(body.direction);
        return this.requireMedia().updateDirection(
            requiredString(body.endpointId, 'endpointId'),
            direction
        );
    }

    private async bridge(params: unknown) {
        const body = requireObject(params);
        const targetSessionId = body.targetSessionId ?? body.target_session_id;
        return this.requireMedia().bridge(requiredString(body.sessionId, 'sessionId'), {
            targetSessionId: requiredString(targetSessionId, 'targetSessionId'),
            direction: optionalDirection(body.direction)
        });
    }

    private async unbridge(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().unbridge(requiredString(body.endpointId, 'endpointId'));
    }

    private async gather(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().gather(requiredString(body.sessionId, 'sessionId'), {
            endpointId: requiredString(body.endpointId, 'endpointId'),
            numDigits: optionalPositiveInteger(body.numDigits, 'numDigits'),
            timeoutMs: optionalPositiveInteger(body.timeoutMs, 'timeoutMs'),
            interDigitTimeoutMs: optionalPositiveInteger(body.interDigitTimeoutMs, 'interDigitTimeoutMs'),
            terminator: optionalString(body.terminator, 'terminator')
        });
    }

    private async playAndGather(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().playAndGather(requiredString(body.sessionId, 'sessionId'), {
            endpointId: requiredString(body.endpointId, 'endpointId'),
            source: requiredString(body.source, 'source'),
            loopCount: optionalNullableInteger(body.loopCount, 'loopCount'),
            cacheTtlSecs: optionalInteger(body.cacheTtlSecs, 'cacheTtlSecs'),
            headers: parseOptionalHeaders(body.headers),
            numDigits: optionalPositiveInteger(body.numDigits, 'numDigits'),
            timeoutMs: optionalPositiveInteger(body.timeoutMs, 'timeoutMs'),
            interDigitTimeoutMs: optionalPositiveInteger(body.interDigitTimeoutMs, 'interDigitTimeoutMs'),
            terminator: optionalString(body.terminator, 'terminator'),
            stopPlaybackOnDigit: optionalBoolean(body.stopPlaybackOnDigit, 'stopPlaybackOnDigit')
        });
    }

    private async leaveMessage(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().leaveMessage(requiredString(body.sessionId, 'sessionId'), {
            endpointId: requiredString(body.endpointId, 'endpointId'),
            messageSource: optionalString(body.messageSource, 'messageSource') ?? optionalString(body.promptSource, 'promptSource'),
            maxWaitMs: optionalPositiveInteger(body.maxWaitMs ?? body.maxDurationMs, 'maxWaitMs'),
            playbackTimeoutMs: optionalPositiveInteger(body.playbackTimeoutMs, 'playbackTimeoutMs'),
            silenceIntervalMs: optionalPositiveInteger(body.silenceIntervalMs, 'silenceIntervalMs'),
            speechThreshold: optionalNumber(body.speechThreshold, 'speechThreshold'),
            terminator: optionalString(body.terminator, 'terminator')
        });
    }

    private async injectDtmf(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().injectDtmf(
            requiredString(body.endpointId, 'endpointId'),
            requiredString(body.digit, 'digit')
        );
    }

    private async startRecording(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().startRecording(requiredString(body.sessionId, 'sessionId'), {
            endpointId: optionalString(body.endpointId, 'endpointId'),
            filePath: optionalString(body.filePath, 'filePath'),
            recordOutbound: optionalBoolean(body.recordOutbound, 'recordOutbound')
        });
    }

    private async stopRecording(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().stopRecording(requiredString(body.recordingId, 'recordingId'));
    }

    private async listRecordings(params: unknown) {
        const body = optionalObject(params);
        return this.requireMedia().listRecordings({
            backendId: optionalString(body.backendId, 'backendId'),
            startsWith: optionalString(body.startsWith, 'startsWith'),
            skip: optionalNonNegativeInteger(body.skip, 'skip'),
            limit: optionalPositiveInteger(body.limit, 'limit')
        });
    }

    private async deleteRecording(params: unknown) {
        const body = requireObject(params);
        return this.requireMedia().deleteRecording(
            requiredString(body.backendId, 'backendId'),
            requiredString(body.path, 'path')
        );
    }

    private requireMedia() {
        if (!this.media) throw new MediaUnavailableError('Media commands require RTPBRIDGE_HOST');
        return this.media;
    }
}

function requireObject(params: unknown): Record<string, unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new CommandValidationError('params must be an object');
    }
    return params as Record<string, unknown>;
}

function optionalObject(params: unknown): Record<string, unknown> {
    if (params === undefined || params === null) return {};
    return requireObject(params);
}

function requiredString(value: unknown, name: string) {
    if (typeof value !== 'string' || !value.trim()) throw new CommandValidationError(`${name} is required`);
    return value;
}

function optionalString(value: unknown, name: string) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new CommandValidationError(`${name} must be a non-empty string`);
    return value;
}

function parseOptionalSipAuth(value: unknown): SipAuthCredentials | undefined {
    if (value === undefined || value === null) return undefined;
    const auth = requireObject(value);
    return {
        username: requiredString(auth.username, 'auth.username'),
        password: requiredString(auth.password, 'auth.password')
    };
}

function optionalBoolean(value: unknown, name: string) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') throw new CommandValidationError(`${name} must be a boolean`);
    return value;
}

function optionalInteger(value: unknown, name: string) {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value)) throw new CommandValidationError(`${name} must be an integer`);
    return value as number;
}

function optionalNumber(value: unknown, name: string) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new CommandValidationError(`${name} must be a number`);
    return value;
}

function optionalNonNegativeInteger(value: unknown, name: string) {
    const parsed = optionalInteger(value, name);
    if (parsed !== undefined && parsed < 0) throw new CommandValidationError(`${name} must be a non-negative integer`);
    return parsed;
}

function optionalPositiveInteger(value: unknown, name: string) {
    const parsed = optionalInteger(value, name);
    if (parsed !== undefined && parsed <= 0) throw new CommandValidationError(`${name} must be a positive integer`);
    return parsed;
}

function optionalNullableInteger(value: unknown, name: string) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Number.isInteger(value)) throw new CommandValidationError(`${name} must be an integer or null`);
    return value as number;
}

function requiredDirection(value: unknown) {
    const direction = requiredString(value, 'direction');
    if (!['sendrecv', 'recvonly', 'sendonly', 'inactive'].includes(direction)) {
        throw new CommandValidationError('direction must be one of sendrecv, recvonly, sendonly, inactive');
    }
    return direction as 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive';
}

function optionalDirection(value: unknown) {
    if (value === undefined || value === null) return undefined;
    return requiredDirection(value);
}

export function controlErrorForCommand(err: unknown) {
    if (err instanceof CommandNotImplementedError) return { code: 'NOT_IMPLEMENTED', message: err.message };
    if (err instanceof CommandValidationError || err instanceof InvalidHttpActionError) return { code: 'BAD_REQUEST', message: err.message };
    if (err instanceof MediaActionConflictError) return { code: 'CONFLICT', message: err.message };
    if (err instanceof CallNotFoundError || err instanceof MediaSessionNotFoundError || err instanceof MediaEndpointNotFoundError || err instanceof MediaBackendNotFoundError) {
        return { code: 'NOT_FOUND', message: err.message };
    }
    if (err instanceof MediaUnavailableError) return { code: 'MEDIA_UNAVAILABLE', message: err.message };
    if (err instanceof MediaRecordingProxyError) {
        if (err.statusCode === 400) return { code: 'BAD_REQUEST', message: err.message };
        return { code: err.statusCode === 404 ? 'NOT_FOUND' : 'RECORDING_PROXY_ERROR', message: err.message };
    }
    return undefined;
}
