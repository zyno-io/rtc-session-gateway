import { CallRegistry } from './call-registry';
import { Config } from './config';
import { ControlHub } from './control-hub';
import { SipGateway } from './sip-gateway';
import { HttpServer } from './http-server';
import { AxiosGatewayHttpClient } from './http-client';
import { MediaServerManager } from './media-server-manager';
import { MediaSessionService } from './media-session-service';
import { GatewayLifecycle } from './gateway-lifecycle';
import { SipFirewall } from './sip-firewall';
import { FirewallPublisher } from './firewall-publisher';

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
    const firewall = new SipFirewall(Config.SIP_FIREWALL);
    const firewallPublisher = new FirewallPublisher(firewall);
    const controlHub = new ControlHub(Config.CONTROL_REQUEST_TIMEOUT_MS);
    const mediaServers =
        Config.RTPBRIDGE_DNS_ALIAS || Config.RTPBRIDGE_HOST || Config.RTC_ENDPOINTS_FILE ? new MediaServerManager(Config) : undefined;
    let media: MediaSessionService | undefined;
    let gateway: SipGateway;
    let httpServer: HttpServer;
    const lifecycle = new GatewayLifecycle({
        maxWaitMs: Config.SHUTDOWN_MAX_WAIT_MS,
        cleanupTimeoutMs: Config.SHUTDOWN_CLEANUP_TIMEOUT_MS,
        activeResources: () => registry.size + registry.pendingCount + (media?.size ?? 0),
        stop: async () => {
            await Promise.allSettled([gateway.shutdown(), media?.shutdown()]);
            await firewallPublisher.stop();
            controlHub.closeConnections();
            mediaServers?.destroy();
            await httpServer.close();
        }
    });
    lifecycle.on('draining', data => controlHub.broadcastEvent({ event: 'gateway.draining', data }));
    lifecycle.once('stopped', () => process.exit(0));
    for (const signal of ['SIGTERM', 'SIGINT'])
        process.on(signal, () => {
            void lifecycle.drain(signal);
        });
    media = mediaServers
        ? new MediaSessionService(
              mediaServers,
              Config.RECORDINGS_PATH,
              controlHub,
              Config.RTPBRIDGE_REQUEST_TIMEOUT_MS,
              {
                  authSecret: Config.COTURN_AUTH_SECRET,
                  credentialTtlSeconds: Config.COTURN_CREDENTIAL_TTL_SECONDS,
                  urls: Config.COTURN_URLS
              },
              lifecycle,
              Config.RECORDING_PATH_PREFIX
          )
        : undefined;
    if (mediaServers) mediaServers.isCallActive = callId => registry.hasCallOrReservation(callId) || !!media?.get(callId);
    gateway = new SipGateway(Config, registry, new AxiosGatewayHttpClient(), undefined, controlHub, lifecycle, {
        media: () => !!mediaServers?.readiness.eligibleBackends,
        firewall,
        mediaController: media
    });
    controlHub.on('disconnect', connectionId => {
        const cleanup = async () => {
            const operations = [gateway.terminateCallsForControlConnection(connectionId)];
            if (media) operations.push(media.destroySessionsForOwner(connectionId));
            await Promise.allSettled(operations);
        };
        if (lifecycle.isStopping) void cleanup();
        else void lifecycle.track(cleanup);
    });
    httpServer = new HttpServer(
        Config,
        registry,
        gateway,
        controlHub,
        media,
        lifecycle,
        () => !!mediaServers?.readiness.eligibleBackends,
        () => mediaServers?.readiness,
        firewall,
        firewallPublisher
    );
    httpServer.start();
    firewallPublisher.start();
    await gateway.start();
}
