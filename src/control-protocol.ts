import type { RouteConfig } from './routing';

export type ControlMessage = ControlRequest | ControlResponse | ControlEvent;

export interface ControlRequest {
    type: 'request';
    id: string;
    method: string;
    params?: unknown;
}

export interface ControlResponse {
    type: 'response';
    id: string;
    ok: boolean;
    result?: unknown;
    error?: ControlErrorBody;
}

export interface ControlEvent {
    type: 'event';
    event: string;
    eventId: string;
    sessionId?: string;
    sequence?: number;
    occurredAt: string;
    data?: unknown;
}

export interface ControlErrorBody {
    code: string;
    message: string;
    details?: unknown;
}

export interface RouteRegistration {
    match: RouteConfig['match'];
    value: string;
}

export class ControlProtocolError extends Error {
    constructor(
        message: string,
        public code = 'BAD_MESSAGE'
    ) {
        super(message);
    }
}

export function parseControlMessage(input: unknown): ControlMessage {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ControlProtocolError('message must be an object');
    }

    const message = input as Record<string, unknown>;
    if (message.type === 'request') return parseControlRequest(message);
    if (message.type === 'response') return parseControlResponse(message);
    if (message.type === 'event') return parseControlEvent(message);
    throw new ControlProtocolError('type must be request, response, or event');
}

export function parseControlRequest(input: Record<string, unknown>): ControlRequest {
    if (typeof input.id !== 'string' || !input.id.trim()) {
        throw new ControlProtocolError('request id must be a non-empty string');
    }
    if (typeof input.method !== 'string' || !input.method.trim()) {
        throw new ControlProtocolError('request method must be a non-empty string');
    }

    return {
        type: 'request',
        id: input.id,
        method: input.method,
        params: input.params
    };
}

export function parseControlResponse(input: Record<string, unknown>): ControlResponse {
    if (typeof input.id !== 'string' || !input.id.trim()) {
        throw new ControlProtocolError('response id must be a non-empty string');
    }
    if (typeof input.ok !== 'boolean') {
        throw new ControlProtocolError('response ok must be a boolean');
    }

    if (input.ok) {
        return { type: 'response', id: input.id, ok: true, result: input.result };
    }

    return {
        type: 'response',
        id: input.id,
        ok: false,
        error: parseControlError(input.error)
    };
}

export function parseControlEvent(input: Record<string, unknown>): ControlEvent {
    if (typeof input.event !== 'string' || !input.event.trim()) {
        throw new ControlProtocolError('event must be a non-empty string');
    }
    if (typeof input.eventId !== 'string' || !input.eventId.trim()) {
        throw new ControlProtocolError('eventId must be a non-empty string');
    }
    if (typeof input.occurredAt !== 'string' || !input.occurredAt.trim()) {
        throw new ControlProtocolError('occurredAt must be a non-empty string');
    }
    if (input.sessionId !== undefined && typeof input.sessionId !== 'string') {
        throw new ControlProtocolError('sessionId must be a string when provided');
    }
    if (input.sequence !== undefined && (!Number.isInteger(input.sequence) || (input.sequence as number) < 1)) {
        throw new ControlProtocolError('sequence must be a positive integer when provided');
    }

    return {
        type: 'event',
        event: input.event,
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        sessionId: input.sessionId as string | undefined,
        sequence: input.sequence as number | undefined,
        data: input.data
    };
}

export function parseRouteRegistrations(input: unknown): RouteRegistration[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ControlProtocolError('params must be an object');
    }
    const routes = (input as Record<string, unknown>).routes;
    if (!Array.isArray(routes)) throw new ControlProtocolError('params.routes must be an array');

    return routes.map((route, index): RouteRegistration => {
        if (!route || typeof route !== 'object' || Array.isArray(route)) {
            throw new ControlProtocolError(`routes[${index}] must be an object`);
        }
        const candidate = route as Record<string, unknown>;
        if (candidate.match !== 'exact' && candidate.match !== 'userPrefix') {
            throw new ControlProtocolError(`routes[${index}].match must be exact or userPrefix`);
        }
        if (typeof candidate.value !== 'string' || !candidate.value.trim()) {
            throw new ControlProtocolError(`routes[${index}].value must be a non-empty string`);
        }
        return { match: candidate.match, value: candidate.value };
    });
}

export function makeControlError(code: string, message: string, details?: unknown): ControlErrorBody {
    return { code, message, details };
}

function parseControlError(input: unknown): ControlErrorBody {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return makeControlError('ERROR', 'Request failed');
    }
    const error = input as Record<string, unknown>;
    return makeControlError(
        typeof error.code === 'string' && error.code.trim() ? error.code : 'ERROR',
        typeof error.message === 'string' && error.message.trim() ? error.message : 'Request failed',
        error.details
    );
}
