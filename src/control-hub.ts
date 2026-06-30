import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import {
    ControlErrorBody,
    ControlResponse,
    ControlProtocolError,
    makeControlError,
    RouteRegistration
} from './control-protocol';
import { BaseLogger } from './logger';
import { InviteDestination, matchRoute, normalizeRouteValue, RouteConfig } from './routing';

export class ControlRequestError extends Error {
    constructor(public error: ControlErrorBody) {
        super(error.message);
    }
}

export class ControlConnectionUnavailableError extends Error { }

interface PendingRequest {
    connectionId: string;
    method: string;
    resolve: (value: unknown) => void;
    reject: (err: unknown) => void;
    timer: NodeJS.Timeout;
}

interface ControlConnection {
    id: string;
    ws: WebSocket;
    routes: RouteConfig[];
    sequenceBySession: Map<string, number>;
}

export interface ControlRouteMatch {
    connectionId: string;
    route: RouteConfig;
}

export class ControlHub extends EventEmitter {
    private logger = BaseLogger.child({ ns: 'ControlHub' });
    private connections = new Map<string, ControlConnection>();
    private pending = new Map<string, PendingRequest>();

    constructor(private requestTimeoutMs: number) {
        super();
    }

    registerConnection(ws: WebSocket) {
        const id = randomUUID();
        this.connections.set(id, {
            id,
            ws,
            routes: [],
            sequenceBySession: new Map()
        });
        ws.on('close', () => this.removeConnection(id));
        ws.on('error', err => this.logger.warn({ err, connectionId: id }, 'Control connection error'));
        return id;
    }

    unregisterConnection(connectionId: string) {
        this.removeConnection(connectionId);
    }

    setRoutes(connectionId: string, routes: RouteRegistration[]) {
        const connection = this.requireConnection(connectionId);
        const nextRoutes = routes.map(route => ({
            match: route.match,
            value: normalizeRouteValue(route.value),
            url: `control://${connectionId}`
        }));
        this.assertRoutesAvailable(connectionId, nextRoutes);
        connection.routes = nextRoutes;
        return connection.routes;
    }

    findRoute(destination: InviteDestination): ControlRouteMatch | undefined {
        for (const connection of this.connections.values()) {
            const route = matchRoute(connection.routes, destination);
            if (route) return { connectionId: connection.id, route };
        }
        return undefined;
    }

    async request(connectionId: string, method: string, params: unknown, timeoutMs = this.requestTimeoutMs) {
        const connection = this.requireConnection(connectionId);
        const id = randomUUID();
        const payload = JSON.stringify({ type: 'request', id, method, params });

        const promise = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ControlConnectionUnavailableError(`Control request ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, { connectionId, method, resolve, reject, timer });
        });

        if (connection.ws.readyState !== WebSocket.OPEN) {
            this.rejectPending(id, new ControlConnectionUnavailableError(`Control connection ${connectionId} is not open`));
        } else {
            try {
                connection.ws.send(payload, err => {
                    if (err) this.rejectPending(id, err);
                });
            } catch (err) {
                this.rejectPending(id, err);
            }
        }

        return promise;
    }

    sendEvent(connectionId: string, event: { event: string; sessionId?: string; data?: unknown }) {
        const connection = this.connections.get(connectionId);
        if (!connection) return false;
        if (connection.ws.readyState !== WebSocket.OPEN) return false;
        const sequence = event.sessionId ? nextSequence(connection.sequenceBySession, event.sessionId) : undefined;
        try {
            connection.ws.send(JSON.stringify({
                type: 'event',
                event: event.event,
                eventId: randomUUID(),
                sessionId: event.sessionId,
                sequence,
                occurredAt: new Date().toISOString(),
                data: event.data
            }), err => {
                if (err) this.logger.warn({ err, connectionId, event: event.event }, 'Control event send failed');
            });
            return true;
        } catch (err) {
            this.logger.warn({ err, connectionId, event: event.event }, 'Control event send failed');
            return false;
        }
    }

    sendRaw(connectionId: string, message: unknown) {
        const connection = this.connections.get(connectionId);
        if (!connection) return false;
        if (connection.ws.readyState !== WebSocket.OPEN) return false;
        try {
            connection.ws.send(JSON.stringify(message), err => {
                if (err) this.logger.warn({ err, connectionId }, 'Control message send failed');
            });
            return true;
        } catch (err) {
            this.logger.warn({ err, connectionId }, 'Control message send failed');
            return false;
        }
    }

    handleResponse(connectionId: string, response: ControlResponse) {
        const pending = this.pending.get(response.id);
        if (!pending) return false;
        if (pending.connectionId !== connectionId) {
            this.logger.warn({
                responseId: response.id,
                expectedConnectionId: pending.connectionId,
                actualConnectionId: connectionId
            }, 'Ignoring response from wrong control connection');
            return false;
        }
        this.pending.delete(response.id);
        clearTimeout(pending.timer);

        if (response.ok) {
            pending.resolve(response.result);
        } else {
            pending.reject(new ControlRequestError(response.error ?? makeControlError('ERROR', 'Request failed')));
        }
        return true;
    }

    isConnected(connectionId: string) {
        return this.connections.has(connectionId);
    }

    get size() {
        return this.connections.size;
    }

    private removeConnection(connectionId: string) {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        this.connections.delete(connectionId);
        for (const [id, pending] of this.pending) {
            if (pending.connectionId !== connectionId) continue;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new ControlConnectionUnavailableError(`Control connection ${connectionId} closed during ${pending.method}`));
        }
        this.emit('disconnect', connectionId);
    }

    private requireConnection(connectionId: string) {
        const connection = this.connections.get(connectionId);
        if (!connection) throw new ControlConnectionUnavailableError(`Control connection ${connectionId} is not available`);
        return connection;
    }

    private rejectPending(id: string, err: unknown) {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(err);
    }

    private assertRoutesAvailable(ownerConnectionId: string, routes: RouteConfig[]) {
        const seen = new Set<string>();
        for (const route of routes) {
            const key = routeKey(route);
            if (seen.has(key)) {
                throw new ControlProtocolError(`duplicate route ${route.match}:${route.value}`, 'ROUTE_CONFLICT');
            }
            seen.add(key);
        }

        for (const connection of this.connections.values()) {
            if (connection.id === ownerConnectionId) continue;
            const claimed = new Set(connection.routes.map(routeKey));
            for (const route of routes) {
                if (claimed.has(routeKey(route))) {
                    throw new ControlProtocolError(`route ${route.match}:${route.value} is already registered`, 'ROUTE_CONFLICT');
                }
            }
        }
    }
}

function nextSequence(sequences: Map<string, number>, sessionId: string) {
    const next = (sequences.get(sessionId) ?? 0) + 1;
    sequences.set(sessionId, next);
    return next;
}

function routeKey(route: RouteConfig) {
    return `${route.match}:${route.value}`;
}
