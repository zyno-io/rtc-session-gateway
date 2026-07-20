import type http from 'node:http';

import { WebSocketServer } from 'ws';

import { ControlHub } from './control-hub';
import {
    ControlErrorBody,
    ControlMessage,
    ControlProtocolError,
    ControlRequest,
    makeControlError,
    parseControlMessage,
    parseRouteRegistrations
} from './control-protocol';
import { CallNotFoundError, InvalidCallStateError } from './drachtio-gateway';
import { BaseLogger } from './logger';
import { controlErrorForCommand, SessionCommandHandler } from './session-commands';

export interface ControlServerConfig {
    CONTROL_WS_PATH: string;
    CONTROL_AUTH_MODE?: 'bearer' | 'none';
    CONTROL_AUTH_TOKEN?: string;
    CONTROL_MAX_PAYLOAD_BYTES?: number;
}

export class ControlServer {
    private logger = BaseLogger.child({ ns: 'ControlServer' });
    private wss: WebSocketServer;

    constructor(
        server: http.Server,
        private config: ControlServerConfig,
        private hub: ControlHub,
        private commands: SessionCommandHandler
    ) {
        this.wss = new WebSocketServer({
            noServer: true,
            maxPayload: this.config.CONTROL_MAX_PAYLOAD_BYTES ?? 1_048_576
        });
        server.on('upgrade', (req, socket, head) => {
            if ((req.url ?? '').split('?')[0] !== this.config.CONTROL_WS_PATH) return;
            if (!this.isAuthorized(req.headers.authorization)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            this.wss.handleUpgrade(req, socket, head, ws => {
                const connectionId = this.hub.registerConnection(ws);
                this.logger.info({ connectionId }, 'Control connection established');
                ws.on('message', data => {
                    this.handleMessage(connectionId, data.toString()).catch(err => {
                        this.logger.warn({ err, connectionId }, 'Control message failed');
                    });
                });
                ws.send(JSON.stringify({
                    type: 'event',
                    event: 'control.connected',
                    eventId: connectionId,
                    occurredAt: new Date().toISOString(),
                    data: { connectionId }
                }));
            });
        });
    }

    close() {
        this.wss.close();
    }

    private async handleMessage(connectionId: string, raw: string) {
        let parsed: ControlMessage;
        try {
            parsed = parseControlMessage(JSON.parse(raw));
        } catch (err) {
            this.sendProtocolError(connectionId, err);
            return;
        }

        if (parsed.type === 'response') {
            this.hub.handleResponse(connectionId, parsed);
            return;
        }

        if (parsed.type === 'event') {
            this.logger.debug({ connectionId, event: parsed.event }, 'Ignoring client event');
            return;
        }

        await this.handleRequest(connectionId, parsed);
    }

    private async handleRequest(connectionId: string, request: ControlRequest) {
        const startedAt = Date.now();
        const logContext = { connectionId, requestId: request.id, method: request.method };
        this.logger.debug(logContext, 'Control request received');
        try {
            const result = request.method === 'route.register'
                ? { routes: this.hub.setRoutes(connectionId, parseRouteRegistrations(request.params)) }
                : await this.commands.execute(request.method, request.params, { controlConnectionId: connectionId });
            this.sendResponse(connectionId, request.id, true, result);
            this.logger.debug({ ...logContext, durationMs: Date.now() - startedAt }, 'Control request completed');
        } catch (err) {
            const error = errorForCommand(err);
            this.logger.warn({ err, ...logContext, code: error.code, durationMs: Date.now() - startedAt }, 'Control request failed');
            this.sendResponse(connectionId, request.id, false, undefined, error);
        }
    }

    private sendProtocolError(connectionId: string, err: unknown) {
        const code = err instanceof ControlProtocolError ? err.code : 'BAD_MESSAGE';
        const message = err instanceof Error ? err.message : 'Bad message';
        this.hub.sendRaw(connectionId, {
            type: 'response',
            id: '',
            ok: false,
            error: makeControlError(code, message)
        });
    }

    private sendResponse(connectionId: string, id: string, ok: boolean, result?: unknown, error?: ControlErrorBody) {
        this.hub.sendRaw(connectionId, ok
            ? { type: 'response', id, ok, result }
            : { type: 'response', id, ok, error });
    }

    private isAuthorized(header: string | undefined) {
        if ((this.config.CONTROL_AUTH_MODE ?? (this.config.CONTROL_AUTH_TOKEN ? 'bearer' : 'none')) === 'none') return true;
        if (!this.config.CONTROL_AUTH_TOKEN) return false;
        return header === `Bearer ${this.config.CONTROL_AUTH_TOKEN}`;
    }
}

function errorForCommand(err: unknown) {
    const commandError = controlErrorForCommand(err);
    if (commandError) return makeControlError(commandError.code, commandError.message);
    if (err instanceof CallNotFoundError) return makeControlError('NOT_FOUND', err.message);
    if (err instanceof InvalidCallStateError) return makeControlError('CONFLICT', err.message);
    if (err instanceof ControlProtocolError) return makeControlError(err.code, err.message);
    return makeControlError('INTERNAL_ERROR', err instanceof Error ? err.message : 'Internal error');
}
