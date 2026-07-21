import path from 'node:path';

import type { ControlEvent, ControlRequest, ControlResponse } from './control-protocol';

const REDACTED = '[REDACTED]';

export interface ControlLogContext {
    method?: string;
    sensitive?: boolean;
}

export interface StructuredControlLogBody {
    type: 'request' | 'response' | 'event';
    id?: unknown;
    method?: string;
    event?: string;
    ok?: boolean;
    value: unknown;
}

export interface ControlErrorLogSummary {
    name: string;
    code?: string;
    sipStatus?: number;
    messageBytes: number;
}

export function scrubControlError(error: unknown): ControlErrorLogSummary {
    const name = error instanceof Error ? safeProtocolName(error.name) : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
    const sipStatusMatch = /sip non-success response:\s*(\d{3})/i.exec(message);
    return {
        name,
        ...(code ? { code } : {}),
        ...(sipStatusMatch ? { sipStatus: Number(sipStatusMatch[1]) } : {}),
        messageBytes: Buffer.byteLength(message)
    };
}

export function scrubControlRequest(request: Pick<ControlRequest, 'id' | 'method' | 'params'>): StructuredControlLogBody {
    return {
        type: 'request',
        id: scrubIdentifier(request.id),
        method: safeProtocolName(request.method),
        value: scrubKnownObject(request.params, requestFields(request.method), {
            method: request.method,
            sensitive: isSensitiveControlRequest(request.method, request.params)
        })
    };
}

export function scrubControlResponse(
    response: Pick<ControlResponse, 'id' | 'ok' | 'result' | 'error'>,
    context: ControlLogContext = {}
): StructuredControlLogBody {
    return {
        type: 'response',
        id: scrubIdentifier(response.id),
        method: context.method ? safeProtocolName(context.method) : undefined,
        ok: response.ok,
        value: response.ok ? scrubKnownObject(response.result, responseFields(context.method), context) : scrubError(response.error)
    };
}

export function scrubControlEvent(event: Pick<ControlEvent, 'event' | 'data'>): StructuredControlLogBody {
    const sensitive = event.event === 'dtmf' || event.event === 'media.rtpbridge' ? eventIsSensitiveDtmf(event.data) : false;
    return {
        type: 'event',
        event: safeProtocolName(event.event),
        value:
            event.event === 'media.rtpbridge'
                ? scrubNestedRtpbridgeEvent(event.data)
                : scrubKnownObject(event.data, eventFields(event.event), { sensitive })
    };
}

export function scrubRtpbridgeRequest(id: string, method: string, params: unknown): StructuredControlLogBody {
    return {
        type: 'request',
        id: scrubIdentifier(id),
        method: safeProtocolName(method),
        value: scrubKnownObject(params, rtpbridgeRequestFields(method), { method })
    };
}

export function scrubRtpbridgeResponse(id: string, method: string, response: { result?: unknown; error?: unknown }): StructuredControlLogBody {
    return {
        type: 'response',
        id: scrubIdentifier(id),
        method: safeProtocolName(method),
        ok: !response.error,
        value: response.error ? scrubError(response.error) : scrubKnownObject(response.result, rtpbridgeResponseFields(method), { method })
    };
}

export function scrubRtpbridgeEvent(event: string, data: unknown): StructuredControlLogBody {
    return {
        type: 'event',
        event: safeProtocolName(event),
        value: scrubKnownObject(data, rtpbridgeEventFields(event), {
            sensitive: event === 'dtmf' ? eventIsSensitiveDtmf(data) : false
        })
    };
}

export function isSensitiveControlRequest(method: string, params: unknown): boolean {
    if (method !== 'media.gather' && method !== 'media.playAndGather') return false;
    return isRecord(params) && params.sensitive === true;
}

function scrubNestedRtpbridgeEvent(value: unknown): unknown {
    if (!isRecord(value) || typeof value.event !== 'string') return typeMarker(value);
    return scrubRtpbridgeEvent(value.event, value.data);
}

function scrubKnownObject(value: unknown, allowedFields: readonly string[], context: ControlLogContext): unknown {
    if (!isRecord(value)) return typeMarker(value);
    const allowed = new Set(allowedFields.map(normalizeField));
    return Object.fromEntries(
        Object.entries(value).map(([key, fieldValue]) => [
            safeFieldName(key),
            allowed.has(normalizeField(key)) ? scrubKnownField(key, fieldValue, context) : typeMarker(fieldValue)
        ])
    );
}

function scrubKnownField(key: string, value: unknown, context: ControlLogContext): unknown {
    const normalized = normalizeField(key);
    if (['password', 'credential', 'connecttoken', 'token', 'authorization'].includes(normalized)) return REDACTED;
    if (['sdp', 'sdpoffer', 'sdpanswer', 'localsdp', 'remotesdp'].includes(normalized)) return summarizeSdp(value);
    if (['headers'].includes(normalized)) return summarizeHeaders(value);
    if (normalized === 'auth') return summarizeAuth(value);
    if (['source', 'messagesource', 'promptsource', 'receiverurl', 'downloadpath'].includes(normalized)) return summarizeUrlOrPath(value);
    if (['requesturi', 'destinationuri', 'sourceuri', 'from', 'to', 'contact', 'proxy'].includes(normalized)) return summarizeUri(value);
    if (['filepath', 'recordingpath', 'path'].includes(normalized)) return summarizePath(value);
    if (normalized === 'digit' || normalized === 'digits') return summarizeDigits(value, context.sensitive ?? true);
    if (normalized === 'terminator') return summarizeDigits(value, false);
    if (normalized.endsWith('id')) return scrubIdentifier(value);
    if (normalized === 'routes') return summarizeRoutes(value);
    if (normalized === 'iceconfiguration') return summarizeIceConfiguration(value);
    if (
        normalized === 'servers' ||
        normalized === 'sessions' ||
        normalized === 'recordings' ||
        normalized === 'endpoints' ||
        normalized === 'codecs'
    ) {
        return summarizeArray(value);
    }
    if (['direction', 'action', 'match', 'event', 'state', 'oldstate', 'newstate', 'endpointtype', 'icestate', 'tone'].includes(normalized)) {
        return summarizeEnum(value);
    }
    if (normalized === 'reason') return summarizeText(value);
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) return value;
    if (typeof value === 'string') return { stringBytes: Buffer.byteLength(value) };
    if (Array.isArray(value)) return summarizeArray(value);
    if (isRecord(value)) return { objectFields: Object.keys(value).length };
    return typeMarker(value);
}

function summarizeSdp(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    const mediaTypes = new Set<string>();
    const codecs = new Set<string>();
    const directions = new Set<string>();
    let candidateCount = 0;
    let hasIce = false;
    let hasSrtp = false;

    for (const rawLine of value.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('m=')) {
            const media = line.slice(2).split(/\s+/, 1)[0];
            if (media && ['audio', 'video', 'application'].includes(media)) mediaTypes.add(media);
        }
        if (line.startsWith('a=rtpmap:')) {
            const codec = line.split(/\s+/, 2)[1]?.split('/', 1)[0];
            if (codec) codecs.add(safeCodec(codec));
        }
        const direction = line.startsWith('a=') ? line.slice(2) : '';
        if (['sendrecv', 'sendonly', 'recvonly', 'inactive'].includes(direction)) directions.add(direction);
        if (line.startsWith('a=candidate:')) candidateCount++;
        if (line.startsWith('a=ice-ufrag:') || line.startsWith('a=ice-pwd:')) hasIce = true;
        if (line.startsWith('a=fingerprint:') || line.startsWith('a=crypto:') || line.includes('RTP/SAVP')) hasSrtp = true;
    }

    return {
        bytes: Buffer.byteLength(value),
        mediaTypes: [...mediaTypes].sort(),
        codecs: [...codecs].sort(),
        directions: [...directions].sort(),
        candidateCount,
        hasIce,
        hasSrtp
    };
}

function summarizeHeaders(value: unknown): unknown {
    if (!isRecord(value)) return typeMarker(value);
    return {
        names: Object.keys(value).map(safeHeaderName).sort(),
        count: Object.keys(value).length
    };
}

function summarizeAuth(value: unknown): unknown {
    if (!isRecord(value)) return typeMarker(value);
    return {
        username: typeof value.username === 'string' ? { present: true, bytes: Buffer.byteLength(value.username) } : typeMarker(value.username),
        password: REDACTED
    };
}

function summarizeUrlOrPath(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    try {
        const url = new URL(value);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return summarizeUri(value);
        return {
            kind: 'url',
            scheme: url.protocol.slice(0, -1),
            host: redactDigitRuns(url.hostname),
            path: redactDigitRuns(url.pathname),
            queryKeys: [...new Set([...url.searchParams.keys()].map(safeQueryKey))].sort(),
            hasUserinfo: !!url.username || !!url.password
        };
    } catch {
        return summarizePath(value);
    }
}

function summarizeUri(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    const match = /^(sips?|https?|wss?):(?:\/\/)?(?:[^@/]+@)?([^;/?]+)([^?#]*)?(?:\?([^#]*))?/i.exec(value);
    if (!match) return { bytes: Buffer.byteLength(value), redacted: true };
    const userPart = value
        .slice(value.indexOf(':') + 1)
        .replace(/^\/\//, '')
        .split('@')[0];
    return {
        scheme: match[1]?.toLowerCase(),
        host: redactDigitRuns(match[2] ?? ''),
        path: redactDigitRuns(match[3] ?? ''),
        user: {
            present: value.includes('@'),
            bytes: value.includes('@') ? Buffer.byteLength(userPart) : 0
        },
        hasQuery: !!match[4]
    };
}

function summarizePath(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    return {
        basename: redactDigitRuns(path.basename(value)),
        bytes: Buffer.byteLength(value)
    };
}

function summarizeDigits(value: unknown, sensitive: boolean): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    if (sensitive || value.length >= 6) return '~'.repeat([...value].length);
    return /^[0-9A-D#*]+$/.test(value) ? value : REDACTED;
}

function summarizeRoutes(value: unknown): unknown {
    if (!Array.isArray(value)) return typeMarker(value);
    return value.map(route => {
        if (!isRecord(route)) return typeMarker(route);
        return {
            match: summarizeEnum(route.match),
            value: scrubIdentifier(route.value)
        };
    });
}

function summarizeIceConfiguration(value: unknown): unknown {
    if (!isRecord(value)) return typeMarker(value);
    const servers = Array.isArray(value.servers)
        ? value.servers.map(server => {
              if (!isRecord(server)) return typeMarker(server);
              const urls = Array.isArray(server.urls) ? server.urls.map(summarizeUri) : [summarizeUri(server.urls)];
              return {
                  urls,
                  username: server.username === undefined ? undefined : { present: true },
                  credential: server.credential === undefined ? undefined : REDACTED
              };
          })
        : typeMarker(value.servers);
    return {
        backendId: scrubIdentifier(value.backendId),
        mediaIp: value.mediaIp === undefined ? undefined : { present: true },
        expiresAt: value.expiresAt === undefined ? undefined : { present: true },
        servers
    };
}

function summarizeArray(value: unknown): unknown {
    return Array.isArray(value) ? { count: value.length } : typeMarker(value);
}

function summarizeEnum(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    const safeValues = new Set([
        'active',
        'answer',
        'auto',
        'buffering',
        'checking',
        'completed',
        'connected',
        'connecting',
        'disconnected',
        'exact',
        'finished',
        'inactive',
        'new',
        'paused',
        'playing',
        'recvonly',
        'reject',
        'rtp',
        'sendonly',
        'sendrecv',
        'userPrefix',
        'webrtc'
    ]);
    return safeValues.has(value) ? value : REDACTED;
}

function summarizeText(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    return { bytes: Buffer.byteLength(value), digitRunsRedacted: redactDigitRuns(value) !== value };
}

function scrubError(value: unknown): unknown {
    if (!isRecord(value)) return typeMarker(value);
    return {
        code: typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : REDACTED,
        message: typeof value.message === 'string' ? { redacted: true, bytes: Buffer.byteLength(value.message) } : typeMarker(value.message),
        details: value.details === undefined ? undefined : typeMarker(value.details)
    };
}

function scrubIdentifier(value: unknown): unknown {
    if (typeof value !== 'string') return typeMarker(value);
    if (value.length > 128 || !/^[A-Za-z0-9_.:@-]+$/.test(value)) {
        return { redacted: true, bytes: Buffer.byteLength(value) };
    }
    return redactDigitRuns(value);
}

function redactDigitRuns(value: string): string {
    return value.replace(/\d{6,}/g, digits => '~'.repeat(digits.length));
}

function safeCodec(value: string): string {
    const codec = value.toLowerCase();
    if (codec === 'pcmu') return 'PCMU';
    if (codec === 'pcma') return 'PCMA';
    if (codec === 'g722') return 'G722';
    if (codec === 'opus') return 'opus';
    if (codec === 'telephone-event') return 'telephone-event';
    return 'other';
}

function safeHeaderName(value: string): string {
    return /^[A-Za-z0-9-]{1,64}$/.test(value) ? value.toLowerCase() : REDACTED;
}

function safeQueryKey(value: string): string {
    return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : REDACTED;
}

function safeFieldName(value: string): string {
    return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : '[REDACTED_FIELD]';
}

function safeProtocolName(value: string): string {
    return /^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(value) ? value : REDACTED;
}

function normalizeField(value: string): string {
    return value.replaceAll('_', '').toLowerCase();
}

function typeMarker(value: unknown): unknown {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return { redacted: true, type };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function eventIsSensitiveDtmf(value: unknown): boolean {
    if (!isRecord(value)) return true;
    if (typeof value.sensitive === 'boolean') return value.sensitive;
    if (value.event === 'dtmf' && isRecord(value.data) && typeof value.data.sensitive === 'boolean') {
        return value.data.sensitive;
    }
    return true;
}

function requestFields(method: string): readonly string[] {
    const fields: Record<string, readonly string[]> = {
        'route.register': ['routes'],
        'session.get': ['sessionId'],
        'session.delete': ['sessionId', 'reason', 'headers'],
        'session.create': ['callId'],
        'sip.createOutbound': ['requestUri', 'sdp', 'headers', 'receiverUrl', 'callingNumber', 'callingName', 'proxy', 'outboundAttemptId', 'auth'],
        'sip.cancelOutbound': ['outboundAttemptId'],
        'sip.reinvite': ['sessionId', 'callId', 'sdp', 'headers', 'event', 'sipCallId', 'receivedAt'],
        'sip.bye': ['sessionId', 'callId', 'reason', 'headers', 'event', 'sipCallId', 'receivedAt'],
        'sip.invite': [
            'event',
            'callId',
            'sipCallId',
            'destinationUri',
            'destinationUser',
            'sourceUri',
            'from',
            'to',
            'contact',
            'headers',
            'sdp',
            'receivedAt'
        ],
        'sip.answered': ['event', 'callId', 'sipCallId', 'headers', 'sdp', 'status', 'reason', 'receivedAt'],
        'sip.terminated': ['event', 'callId', 'sipCallId', 'headers', 'sdp', 'status', 'reason', 'receivedAt'],
        'webrtc.createOffer': ['sessionId', 'direction'],
        'webrtc.createFromOffer': ['sessionId', 'sdp', 'direction'],
        'webrtc.acceptAnswer': ['endpointId', 'sdp', 'offerGeneration'],
        'webrtc.acceptOffer': ['endpointId', 'sdp'],
        'webrtc.restartIce': ['endpointId'],
        'rtp.createOffer': ['sessionId', 'direction', 'srtp', 'srtpOptional', 'codecs'],
        'rtp.createFromOffer': ['sessionId', 'sdp', 'direction'],
        'rtp.acceptAnswer': ['endpointId', 'sdp'],
        'rtp.reinvite': ['endpointId', 'sdp'],
        'media.play': ['sessionId', 'source', 'loopCount', 'cacheTtlSecs', 'headers'],
        'media.playAndWait': ['sessionId', 'source', 'playbackTimeoutMs'],
        'media.stop': ['endpointId'],
        'endpoint.updateDirection': ['endpointId', 'direction'],
        'media.bridge': ['sessionId', 'targetSessionId', 'target_session_id', 'direction'],
        'media.unbridge': ['endpointId'],
        'media.gather': ['sessionId', 'endpointId', 'numDigits', 'timeoutMs', 'interDigitTimeoutMs', 'terminator', 'sensitive'],
        'media.playAndGather': [
            'sessionId',
            'endpointId',
            'source',
            'loopCount',
            'cacheTtlSecs',
            'headers',
            'numDigits',
            'timeoutMs',
            'interDigitTimeoutMs',
            'terminator',
            'stopPlaybackOnDigit',
            'postPlaybackTimeoutMs',
            'sensitive'
        ],
        'media.leaveMessage': [
            'sessionId',
            'endpointId',
            'messageSource',
            'promptSource',
            'maxWaitMs',
            'maxDurationMs',
            'playbackTimeoutMs',
            'silenceIntervalMs',
            'speechThreshold',
            'terminator'
        ],
        'dtmf.inject': ['endpointId', 'digit'],
        'recording.start': ['sessionId', 'endpointId', 'filePath', 'recordOutbound'],
        'recording.stop': ['recordingId'],
        'recording.list': ['backendId', 'startsWith', 'skip', 'limit'],
        'recording.delete': ['backendId', 'path'],
        'event.ack': ['eventId', 'sessionId', 'sequence']
    };
    return fields[method] ?? [];
}

function responseFields(method: string | undefined): readonly string[] {
    if (!method) return [];
    const common = [
        'ok',
        'sessionId',
        'sipCallId',
        'outboundAttemptId',
        'endpointId',
        'targetEndpointId',
        'recordingId',
        'backendId',
        'sdp',
        'sdpOffer',
        'sdpAnswer',
        'offerGeneration',
        'iceConfiguration',
        'action',
        'status',
        'reason',
        'headers',
        'receiverUrl',
        'digits',
        'terminatedBy',
        'playbackEndpointId',
        'messagePlayed',
        'terminator',
        'played',
        'deleted',
        'filePath',
        'recordingPath',
        'downloadPath',
        'durationMs',
        'packets',
        'routes',
        'sessions',
        'recordings',
        'total',
        'skip',
        'limit'
    ];
    const knownWithoutParams = ['session.list'];
    return requestFields(method).length || knownWithoutParams.includes(method) || method.startsWith('sip.') ? common : [];
}

function eventFields(event: string): readonly string[] {
    if (event === 'control.connected') return ['connectionId'];
    if (event === 'dtmf') return ['endpointId', 'digit', 'durationMs', 'sensitive'];
    if (event.startsWith('sip.')) return requestFields(event);
    return [];
}

function rtpbridgeRequestFields(method: string): readonly string[] {
    const fields: Record<string, readonly string[]> = {
        'session.create': [],
        'session.destroy': ['sessionId'],
        'server.info': [],
        'endpoint.webrtc.create_offer': ['sessionId', 'direction'],
        'endpoint.webrtc.create_from_offer': ['sessionId', 'sdp', 'direction'],
        'endpoint.webrtc.accept_answer': ['endpointId', 'sdp', 'offerGeneration'],
        'endpoint.webrtc.accept_offer': ['endpointId', 'sdp'],
        'endpoint.webrtc.ice_restart': ['endpointId'],
        'endpoint.rtp.create_offer': ['sessionId', 'direction', 'srtp', 'srtpOptional', 'codecs'],
        'endpoint.rtp.create_from_offer': ['sessionId', 'sdp', 'direction'],
        'endpoint.rtp.accept_answer': ['endpointId', 'sdp'],
        'endpoint.rtp.reinvite': ['endpointId', 'sdp'],
        'session.bridge': ['targetSessionId', 'direction'],
        'endpoint.dtmf.inject': ['endpointId', 'digit'],
        'endpoint.dtmf.set_sensitive': ['endpointId', 'enabled'],
        'endpoint.create_with_file': ['sessionId', 'source', 'loopCount', 'startMs', 'timeoutMs', 'cacheTtlSecs', 'shared', 'headers'],
        'endpoint.create_tone': ['sessionId', 'tone', 'frequency', 'durationMs'],
        'endpoint.remove': ['endpointId'],
        'endpoint.update_direction': ['endpointId', 'direction'],
        'recording.start': ['sessionId', 'endpointId', 'filePath', 'recordOutbound'],
        'recording.stop': ['recordingId'],
        'vad.start': ['endpointId', 'silenceIntervalMs', 'speechThreshold'],
        'vad.stop': ['endpointId']
    };
    return fields[method] ?? [];
}

function rtpbridgeResponseFields(method: string): readonly string[] {
    const common = [
        'sessionId',
        'endpointId',
        'targetEndpointId',
        'recordingId',
        'sdp',
        'sdpOffer',
        'sdpAnswer',
        'offerGeneration',
        'connectToken',
        'filePath',
        'durationMs',
        'packets',
        'hostname',
        'version',
        'mediaIp',
        'tone',
        'ok'
    ];
    return rtpbridgeRequestFields(method).length || ['session.create', 'server.info'].includes(method) ? common : [];
}

function rtpbridgeEventFields(event: string): readonly string[] {
    const common = [
        'endpointId',
        'recordingId',
        'targetSessionId',
        'sourceSessionId',
        'sessionId',
        'digit',
        'durationMs',
        'sensitive',
        'oldState',
        'newState',
        'iceState',
        'reason',
        'error',
        'filePath',
        'packets',
        'droppedPackets',
        'silenceDurationMs',
        'timeoutRemainingMs',
        'idleTimeoutSecs',
        'emptyTimeoutSecs',
        'count',
        'endpoints'
    ];
    const known =
        event === 'dtmf' ||
        event.startsWith('endpoint.') ||
        event.startsWith('recording.') ||
        event.startsWith('session.') ||
        event.startsWith('vad.') ||
        event.startsWith('fax.') ||
        event === 'events.dropped' ||
        event === 'stats';
    return known ? common : [];
}
