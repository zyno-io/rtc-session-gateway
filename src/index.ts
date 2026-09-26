import { CallRegistry } from './call-registry';
import { Config } from './config';
import { ControlHub } from './control-hub';
import { DrachtioGateway } from './drachtio-gateway';
import { HttpServer } from './http-server';
import { AxiosGatewayHttpClient } from './http-client';
import { MediaServerManager } from './media-server-manager';
import { MediaSessionService } from './media-session-service';
import { GatewayLifecycle } from './gateway-lifecycle';

process.on('unhandledRejection', err => {
    console.error(err);
    process.exit(1);
});

process.on('uncaughtException', err => {
    console.error(err);
    process.exit(1);
});

run().catch(err => {
    console.error(err);
    process.exit(1);
});

async function run() {
    const registry = new CallRegistry();
    const controlHub = new ControlHub(Config.CONTROL_REQUEST_TIMEOUT_MS);
    const mediaServers = Config.RTPBRIDGE_HOST || Config.RTPBRIDGE_ENDPOINTS_FILE ? new MediaServerManager(Config) : undefined;
    let media: MediaSessionService | undefined;
    let gateway: DrachtioGateway;
    let httpServer: HttpServer;
    const lifecycle = new GatewayLifecycle({
        maxWaitMs: Config.SHUTDOWN_MAX_WAIT_MS,
        cleanupTimeoutMs: Config.SHUTDOWN_CLEANUP_TIMEOUT_MS,
        activeResources: () => registry.size + registry.pendingCount + (media?.size ?? 0),
        stop: async () => {
            await Promise.allSettled([gateway.shutdown(), media?.shutdown()]);
            controlHub.closeConnections();
            mediaServers?.destroy();
            await httpServer.close();
        }
    });
    lifecycle.on('draining', data => controlHub.broadcastEvent({ event: 'gateway.draining', data }));
    lifecycle.once('stopped', () => process.exit(0));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void lifecycle.drain(signal); });
    media = mediaServers
        ? new MediaSessionService(mediaServers, Config.RECORDINGS_PATH, controlHub, Config.RTPBRIDGE_REQUEST_TIMEOUT_MS, {
              authSecret: Config.COTURN_AUTH_SECRET,
              credentialTtlSeconds: Config.COTURN_CREDENTIAL_TTL_SECONDS,
              urls: Config.COTURN_URLS
          }, lifecycle)
        : undefined;
    if (mediaServers) mediaServers.isCallActive = callId => registry.hasCallOrReservation(callId) || !!media?.get(callId);
    gateway = new DrachtioGateway(Config, registry, new AxiosGatewayHttpClient(), undefined, controlHub, {}, lifecycle);
    controlHub.on('disconnect', connectionId => {
        const cleanup = async () => {
            const operations = [gateway.terminateCallsForControlConnection(connectionId)];
            if (media) operations.push(media.destroySessionsForOwner(connectionId));
            await Promise.allSettled(operations);
        };
        if (lifecycle.isStopping) void cleanup();
        else void lifecycle.track(cleanup);
    });
    httpServer = new HttpServer(Config, registry, gateway, controlHub, media, lifecycle,
        () => !!mediaServers?.readiness.eligibleBackends,
        () => mediaServers?.readiness
    );
    httpServer.start();
    await gateway.start();
}
