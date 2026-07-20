import { CallRegistry } from './call-registry';
import { Config } from './config';
import { ControlHub } from './control-hub';
import { DrachtioGateway } from './drachtio-gateway';
import { HttpServer } from './http-server';
import { AxiosGatewayHttpClient } from './http-client';
import { MediaServerManager } from './media-server-manager';
import { MediaSessionService } from './media-session-service';

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
    const mediaServers = Config.RTPBRIDGE_HOST ? new MediaServerManager(Config) : undefined;
    const media = mediaServers
        ? new MediaSessionService(mediaServers, Config.RECORDINGS_PATH, controlHub, Config.RTPBRIDGE_REQUEST_TIMEOUT_MS, {
              authSecret: Config.COTURN_AUTH_SECRET,
              credentialTtlSeconds: Config.COTURN_CREDENTIAL_TTL_SECONDS
          })
        : undefined;
    if (mediaServers) mediaServers.isCallActive = callId => !!registry.get(callId) || !!media?.get(callId);
    const gateway = new DrachtioGateway(Config, registry, new AxiosGatewayHttpClient(), undefined, controlHub);
    controlHub.on('disconnect', connectionId => {
        const cleanup = [gateway.terminateCallsForControlConnection(connectionId)];
        if (media) cleanup.push(media.destroySessionsForOwner(connectionId));
        void Promise.allSettled(cleanup);
    });
    new HttpServer(Config, registry, gateway, controlHub, media).start();
    await gateway.start();
}
