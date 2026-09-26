import axios from 'axios';
import express from 'express';
import http from 'node:http';

import type { FileEndpointCatalog } from './endpoint-catalog';

import { CallRegistry } from './call-registry';
import { GatewayConfig } from './config';
import { ControlHub } from './control-hub';
import { ControlServer } from './control-server';
import {
    CallNotFoundError,
    DrachtioGateway,
    InvalidCallStateError,
    type OutboundSipCallParams,
    type OutboundSipCallResult
} from './drachtio-gateway';
import { InvalidHttpActionError, parseOptionalHeaders } from './http-contract';
import { BaseLogger } from './logger';
import { GatewayDrainingError, GatewayLifecycle } from './gateway-lifecycle';
import type { GatewayMediaController } from './media-controller';
import { MediaBackendNotFoundError, MediaBackendUnavailableError } from './media-server-manager';
import { MediaActionConflictError, MediaEndpointNotFoundError, MediaRecordingProxyError, MediaSessionNotFoundError, MediaUnavailableError } from './media-session-service';
import { acceptsSipHost, getSipUser, matchRoute } from './routing';
import { CommandNotImplementedError, CommandValidationError, SessionCommandHandler } from './session-commands';

export interface GatewayController {
    isConnected: boolean;
    createOutbound(params: OutboundSipCallParams): Promise<OutboundSipCallResult>;
    cancelOutbound?(outboundAttemptId: string, controlConnectionId?: string): Promise<{ ok: true }>;
    reinvite(callId: string, sdp: string, headers?: Record<string, string>): Promise<{ sdp: string }>;
    bye(callId: string, reason?: string, headers?: Record<string, string>): Promise<void>;
}

type RecordingPathRouteParams = {
    backendId: string;
    recordingPath: string[];
};

type CallRouteParams = {
    callId: string;
};

export type HttpAuthConfig = Pick<GatewayConfig, 'CONTROL_AUTH_MODE' | 'CONTROL_AUTH_TOKEN'>;

export type DrachtioHttpRouteConfig = Pick<
    GatewayConfig,
    | 'DRACHTIO_APP_TAG' | 'DRACHTIO_ROUTE_FALLBACK_URL' | 'INVITE_HTTP_TIMEOUT_MS' | 'ROUTES'
    | 'SIP_ALLOWED_DOMAINS'
    | 'RTPBRIDGE_REQUIRED'
    | 'ROUTES_REQUIRED'
>;

type HttpServerConfig = Pick<GatewayConfig, 'HTTP_PORT' | 'CONTROL_WS_PATH' | 'CONTROL_MAX_PAYLOAD_BYTES'> &
    HttpAuthConfig &
    DrachtioHttpRouteConfig;

export class HttpServer {
    private logger = BaseLogger.child({ ns: 'HttpServer' });
    private server?: http.Server;
    private controlServer?: ControlServer;

    constructor(
        private config: HttpServerConfig,
        private registry: CallRegistry,
        private gateway: GatewayController,
        private controlHub?: ControlHub,
        private media?: GatewayMediaController,
        private lifecycle?: GatewayLifecycle,
        private mediaReady: () => boolean = () => true,
        private mediaStatus: () => FileEndpointCatalog['status'] | undefined = () => undefined
    ) { }

    start() {
        const app = createHttpApp(this.registry, this.gateway, this.media, this.config, this.config, this.controlHub, this.lifecycle,
            this.mediaReady,
            this.mediaStatus
        );
        const server = http.createServer(app);
        this.server = server;
        if (this.controlHub) {
            this.controlServer = new ControlServer(
                server,
                {
                    CONTROL_WS_PATH: this.config.CONTROL_WS_PATH,
                    CONTROL_AUTH_MODE: this.config.CONTROL_AUTH_MODE,
                    CONTROL_AUTH_TOKEN: this.config.CONTROL_AUTH_TOKEN,
                    CONTROL_MAX_PAYLOAD_BYTES: this.config.CONTROL_MAX_PAYLOAD_BYTES
                },
                this.controlHub,
                new SessionCommandHandler(this.registry, this.gateway, this.media, this.lifecycle),
                this.lifecycle
            );
        }
        server.listen(this.config.HTTP_PORT, () => {
            this.logger.info({ port: this.config.HTTP_PORT }, 'HTTP server listening');
        });
    }

    async close() {
        this.controlServer?.close();
        const server = this.server;
        if (!server) return;
        await new Promise<void>(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }
}

export function createHttpApp(
    registry: CallRegistry,
    gateway: GatewayController,
    media?: GatewayMediaController,
    authConfig?: HttpAuthConfig,
    drachtioRouteConfig?: DrachtioHttpRouteConfig,
    controlHub?: ControlHub,
    lifecycle?: GatewayLifecycle,
    mediaReady: () => boolean = () => true,
    mediaStatus: () => FileEndpointCatalog['status'] | undefined = () => undefined
) {
    const logger = BaseLogger.child({ ns: 'Http' });
    const app = express();
    const commands = new SessionCommandHandler(registry, gateway, media, lifecycle);
    const routeCount = () => (controlHub?.routeCount ?? 0) + (drachtioRouteConfig?.ROUTES.length ?? 0);
    const admitting = () => gateway.isConnected && !lifecycle?.isDraining && (!drachtioRouteConfig?.RTPBRIDGE_REQUIRED || mediaReady()) &&
        (!drachtioRouteConfig?.ROUTES_REQUIRED || routeCount() > 0);
    const lookup = (destinationUri: string, destinationUser = getSipUser(destinationUri)) => {
        const destination = { destinationUri, destinationUser };
        const matched =
            acceptsSipHost(destinationUri, drachtioRouteConfig?.SIP_ALLOWED_DOMAINS) &&
            (!!controlHub?.findRoute(destination) || !!matchRoute(drachtioRouteConfig?.ROUTES ?? [], destination));
        const acceptNew = matched && admitting() && !!drachtioRouteConfig?.DRACHTIO_APP_TAG;
        return {
            matched,
            acceptNew,
            ...(acceptNew ? { tag: drachtioRouteConfig!.DRACHTIO_APP_TAG } : {})
        };
    };

    app.use('/routing', express.json({ limit: '16kb' }));

    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => {
        if (req.url !== '/healthz') logger.info({ method: req.method, url: req.url }, 'Request');
        next();
    });

    app.get('/healthz', (_req, res) => {
        res.status(gateway.isConnected ? 200 : 503).send({ ok: gateway.isConnected, calls: registry.size });
    });

    app.get('/readyz', (_req, res) => {
        const ready = admitting();
        res.status(ready ? 200 : 503).send({ ok: ready, draining: lifecycle?.isDraining ?? false });
    });

    app.use((_req, res, next) => {
        try {
            const finish = lifecycle?.beginOperation();
            res.once('finish', () => finish?.());
            res.once('close', () => finish?.());
            next();
        } catch (err) {
            next(err);
        }
    });

    if (drachtioRouteConfig?.DRACHTIO_APP_TAG) {
        app.get('/drachtio/route', asyncHandler(async (req, res) => {
            const destinationUri = queryString(req.query.uri) ?? buildSipUri(req.query);
            const destinationUser = queryString(req.query.uriUser) ?? getSipUser(destinationUri);
            const hasGatewayRoute = lookup(destinationUri, destinationUser).matched;
            if (!acceptsSipHost(destinationUri, drachtioRouteConfig.SIP_ALLOWED_DOMAINS)) {
                res.send(drachtioReject(404, 'No Route'));
                return;
            }

            if (hasGatewayRoute) {
                if (!admitting()) {
                    res.send(drachtioReject(503, 'Service Unavailable'));
                    return;
                }
                res.send({
                    action: 'route',
                    data: { tag: drachtioRouteConfig.DRACHTIO_APP_TAG }
                });
                return;
            }

            if (!drachtioRouteConfig.DRACHTIO_ROUTE_FALLBACK_URL) {
                res.send(drachtioReject(404, 'No Route'));
                return;
            }

            try {
                const response = await axios.get(drachtioRouteConfig.DRACHTIO_ROUTE_FALLBACK_URL, {
                    params: req.query,
                    timeout: drachtioRouteConfig.INVITE_HTTP_TIMEOUT_MS,
                    responseType: 'text',
                    transformResponse: [data => data],
                    validateStatus: () => true
                });
                const contentType = response.headers['content-type'];
                if (typeof contentType === 'string') res.type(contentType);
                res.status(response.status).send(response.data);
            } catch (err) {
                logger.error({ err }, 'Drachtio fallback route lookup failed');
                res.send(drachtioReject(502, 'Route Lookup Failed'));
            }
        }));
    }

    app.use(httpBearerAuth(authConfig));

    app.get('/routing/status', (_req, res) => {
        res.send({
            acceptNew: admitting() && !!drachtioRouteConfig?.DRACHTIO_APP_TAG,
            draining: lifecycle?.isDraining ?? false,
            tag: drachtioRouteConfig?.DRACHTIO_APP_TAG,
            media: mediaStatus(),
            routeCount: routeCount()
        });
    });
    app.post('/routing/lookup', (req, res, next) => {
        try {
            const body: unknown = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandValidationError('Lookup requires a JSON object');
            const source = body as Record<string, unknown>;
            if (
                typeof source.destinationUri !== 'string' ||
                !/^sips?:/i.test(source.destinationUri) ||
                source.destinationUri.length > 2048 ||
                (source.destinationUser !== undefined && (typeof source.destinationUser !== 'string' || source.destinationUser.length > 256))
            ) {
                throw new CommandValidationError('Invalid SIP lookup destination');
            }
            res.send(lookup(source.destinationUri, source.destinationUser as string | undefined));
        } catch (err) {
            next(err);
        }
    });

    app.get('/calls', (_req, res) => {
        res.send({ calls: registry.list() });
    });

    app.get('/sessions', (_req, res) => {
        res.send({ sessions: [...registry.list(), ...(media?.list() ?? [])] });
    });

    app.get('/calls/:callId', (req, res) => {
        const call = registry.get(req.params.callId);
        if (!call) {
            res.status(404).send({ error: 'Call not found' });
            return;
        }
        const { dialog: _dialog, ...snapshot } = call;
        res.send(snapshot);
    });

    app.get('/sessions/:sessionId', (req, res) => {
        const call = registry.get(req.params.sessionId);
        if (call) {
            const { dialog: _dialog, ...snapshot } = call;
            res.send(snapshot);
            return;
        }
        const mediaSession = media?.get(req.params.sessionId);
        if (mediaSession) {
            res.send(mediaSession);
            return;
        }
        res.status(404).send({ error: 'Session not found' });
    });

    app.post('/sessions', asyncHandler(async (req, res) => {
        res.send(await commands.execute('session.create', req.body ?? {}));
    }));

    app.post('/calls', asyncHandler(async (req, res) => {
        res.send(await commands.execute('sip.createOutbound', req.body ?? {}));
    }));

    app.delete('/sessions/:sessionId', asyncHandler(async (req, res) => {
        res.send(await commands.execute('session.delete', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/webrtc/offers', asyncHandler(async (req, res) => {
        res.send(await commands.execute('webrtc.createOffer', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/webrtc/from-offer', asyncHandler(async (req, res) => {
        res.send(await commands.execute('webrtc.createFromOffer', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/endpoints/:endpointId/webrtc/answer', asyncHandler(async (req, res) => {
        res.send(await commands.execute('webrtc.acceptAnswer', { ...(req.body ?? {}), endpointId: req.params.endpointId }));
    }));

    app.post('/endpoints/:endpointId/webrtc/offer-answer', asyncHandler(async (req, res) => {
        res.send(await commands.execute('webrtc.acceptOffer', { ...(req.body ?? {}), endpointId: req.params.endpointId }));
    }));

    app.post('/endpoints/:endpointId/webrtc/ice-restart', asyncHandler(async (req, res) => {
        res.send(await commands.execute('webrtc.restartIce', { endpointId: req.params.endpointId }));
    }));

    app.post('/sessions/:sessionId/rtp/offers', asyncHandler(async (req, res) => {
        res.send(await commands.execute('rtp.createOffer', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/rtp/from-offer', asyncHandler(async (req, res) => {
        res.send(await commands.execute('rtp.createFromOffer', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/endpoints/:endpointId/rtp/answer', asyncHandler(async (req, res) => {
        res.send(await commands.execute('rtp.acceptAnswer', { ...(req.body ?? {}), endpointId: req.params.endpointId }));
    }));

    app.post('/endpoints/:endpointId/rtp/reinvite', asyncHandler(async (req, res) => {
        res.send(await commands.execute('rtp.reinvite', { ...(req.body ?? {}), endpointId: req.params.endpointId }));
    }));

    app.post('/sessions/:sessionId/media/play', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.play', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/media/play-and-wait', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.playAndWait', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/media/bridge', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.bridge', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/media/bridges/:endpointId/unbridge', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.unbridge', { endpointId: req.params.endpointId }));
    }));

    app.delete('/media/bridges/:endpointId', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.unbridge', { endpointId: req.params.endpointId }));
    }));

    app.post('/sessions/:sessionId/media/gather', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.gather', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/media/play-and-gather', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.playAndGather', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/sessions/:sessionId/media/leave-message', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.leaveMessage', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/media/endpoints/:endpointId/dtmf', asyncHandler(async (req, res) => {
        res.send(await commands.execute('dtmf.inject', { ...(req.body ?? {}), endpointId: req.params.endpointId }));
    }));

    app.post('/media/endpoints/:endpointId/direction', asyncHandler(async (req, res) => {
        res.send(await commands.execute('endpoint.updateDirection', { ...(req.body ?? {}), endpointId: req.params.endpointId }));
    }));

    app.delete('/media/endpoints/:endpointId', asyncHandler(async (req, res) => {
        res.send(await commands.execute('media.stop', { endpointId: req.params.endpointId }));
    }));

    app.post('/sessions/:sessionId/recordings', asyncHandler(async (req, res) => {
        res.send(await commands.execute('recording.start', { ...(req.body ?? {}), sessionId: req.params.sessionId }));
    }));

    app.post('/recordings/:recordingId/stop', asyncHandler(async (req, res) => {
        res.send(await commands.execute('recording.stop', { recordingId: req.params.recordingId }));
    }));

    app.get('/recordings', asyncHandler(async (req, res) => {
        res.send(await commands.execute('recording.list', recordingListQuery(req.query)));
    }));

    app.get('/recordings/:backendId', asyncHandler(async (req, res) => {
        res.send(await commands.execute('recording.list', {
            ...recordingListQuery(req.query),
            backendId: req.params.backendId
        }));
    }));

    app.post('/recordings/merge', asyncHandler(async (req, res) => {
        if (!media) throw new MediaUnavailableError('Media commands require RTPBRIDGE_HOST');
        const result = await media.mergeRecordings(recordingMergeTargets(req.body?.targets));
        res.status(result.status);
        copyRecordingHeaders(result.headers, res);
        pipeRecordingStream(result.stream, res);
    }));

    app.get('/recordings/:backendId/*recordingPath', asyncHandler<RecordingPathRouteParams>(async (req, res) => {
        if (!media) throw new MediaUnavailableError('Media commands require RTPBRIDGE_HOST');
        const result = await media.downloadRecording(req.params.backendId, req.params.recordingPath.join('/'));
        res.status(result.status);
        copyRecordingHeaders(result.headers, res);
        pipeRecordingStream(result.stream, res);
    }));

    app.delete('/recordings/:backendId/*recordingPath', asyncHandler<RecordingPathRouteParams>(async (req, res) => {
        res.send(await commands.execute('recording.delete', {
            backendId: req.params.backendId,
            path: req.params.recordingPath.join('/')
        }));
    }));

    app.post('/calls/:callId/reinvite', asyncHandler<CallRouteParams>(async (req, res) => {
        if (typeof req.body?.sdp !== 'string' || !req.body.sdp.trim()) {
            res.status(400).send({ error: 'Missing sdp' });
            return;
        }

        const headers = parseOptionalHeaders(req.body.headers);
        const result = await gateway.reinvite(req.params.callId, req.body.sdp, headers);
        res.send(result);
    }));

    app.post('/calls/:callId/bye', asyncHandler<CallRouteParams>(async (req, res) => {
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
        const headers = parseOptionalHeaders(req.body?.headers);
        await gateway.bye(req.params.callId, reason, headers);
        res.send({ ok: true });
    }));

    app.post(['/drain', '/terminate'], (_req, res) => {
        if (!lifecycle) {
            res.status(503).send({ error: 'Gateway shutdown lifecycle unavailable' });
            return;
        }
        void lifecycle.drain('http');
        res.status(202).send({ ok: true, draining: true });
    });

    app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (res.headersSent) {
            next(err);
            return;
        }
        if (err?.type === 'entity.too.large' || err?.type === 'entity.parse.failed') {
            res.status(err.type === 'entity.too.large' ? 413 : 400).send({ error: 'Invalid JSON request body' });
            return;
        }
        if (err instanceof GatewayDrainingError) {
            res.setHeader('Retry-After', '1');
            res.status(503).send({ error: err.message, code: 'SHUTTING_DOWN' });
            return;
        }

        if (err instanceof CallNotFoundError) {
            res.status(404).send({ error: 'Call not found' });
            return;
        }
        if (err instanceof MediaSessionNotFoundError || err instanceof MediaEndpointNotFoundError || err instanceof MediaBackendNotFoundError) {
            res.status(404).send({ error: err.message || 'Media resource not found' });
            return;
        }
        if (err instanceof InvalidCallStateError) {
            res.status(409).send({ error: err.message || 'Invalid call state' });
            return;
        }
        if (err instanceof MediaActionConflictError) {
            res.status(409).send({ error: err.message });
            return;
        }
        if (err instanceof MediaUnavailableError || err instanceof MediaBackendUnavailableError) {
            res.status(503).send({ error: err.message });
            return;
        }
        if (err instanceof MediaRecordingProxyError) {
            res.status(err.statusCode).send({ error: err.message });
            return;
        }
        if (err instanceof CommandValidationError || err instanceof InvalidHttpActionError) {
            res.status(400).send({ error: err.message });
            return;
        }
        if (err instanceof CommandNotImplementedError) {
            res.status(501).send({ error: err.message });
            return;
        }

        logger.error({ err }, 'HTTP request failed');
        res.status(500).send({ error: 'Internal Server Error' });
    });

    return app;
}

function asyncHandler<RouteParams = express.Request['params']>(fn: (req: express.Request<RouteParams>, res: express.Response) => Promise<void>) {
    return (req: express.Request<RouteParams>, res: express.Response, next: express.NextFunction) => {
        fn(req, res).catch(next);
    };
}

function httpBearerAuth(authConfig?: HttpAuthConfig) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (authConfig?.CONTROL_AUTH_MODE !== 'bearer') {
            next();
            return;
        }

        if (req.get('authorization') !== `Bearer ${authConfig.CONTROL_AUTH_TOKEN}`) {
            res.status(401).send({ error: 'Unauthorized' });
            return;
        }

        next();
    };
}

function queryString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildSipUri(query: express.Request['query']) {
    const user = queryString(query.uriUser) ?? queryString(query.toUser) ?? '';
    const domain = queryString(query.domain);
    return `sip:${user}${domain ? `@${domain}` : ''}`;
}

function drachtioReject(status: number, reason: string) {
    return {
        action: 'reject',
        data: { status, reason }
    };
}

function recordingListQuery(query: express.Request['query']) {
    return {
        startsWith: typeof query.startsWith === 'string' ? query.startsWith : undefined,
        skip: parseQueryInteger(query.skip),
        limit: parseQueryInteger(query.limit)
    };
}

function parseQueryInteger(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
}

function recordingMergeTargets(value: unknown) {
    if (!Array.isArray(value)) throw new CommandValidationError('targets must be an array');
    return value.map((target, index) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            throw new CommandValidationError(`targets[${index}] must be an object`);
        }
        const candidate = target as Record<string, unknown>;
        if (typeof candidate.backendId !== 'string' || !candidate.backendId.trim()) {
            throw new CommandValidationError(`targets[${index}].backendId is required`);
        }
        if (typeof candidate.path !== 'string' || !candidate.path.trim()) {
            throw new CommandValidationError(`targets[${index}].path is required`);
        }
        return {
            backendId: candidate.backendId,
            path: candidate.path
        };
    });
}

function copyRecordingHeaders(headers: Record<string, unknown>, res: express.Response) {
    for (const name of ['content-type', 'content-length', 'content-disposition', 'cache-control', 'etag', 'last-modified']) {
        const value = headers[name];
        if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
            res.setHeader(name, value as any);
        }
    }
}

function pipeRecordingStream(stream: NodeJS.ReadableStream, res: express.Response) {
    const readable = stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void };
    res.once('close', () => {
        if (!res.writableEnded) readable.destroy?.();
    });
    readable.once?.('error', err => {
        res.destroy(err instanceof Error ? err : undefined);
    });
    readable.pipe(res);
}
