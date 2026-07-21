import assert from 'node:assert/strict';
import test from 'node:test';

import { GatewayConfig } from '../src/config';
import { MediaServerManager, MediaServerResolver } from '../src/media-server-manager';

test('media server manager resolves SRV records into stable sorted backend ids', async () => {
    const resolver = new FakeResolver({
        srv: [{ name: 'rtpbridge-2.svc.local.' }, { name: 'rtpbridge-0.svc.local.' }]
    });
    const manager = new MediaServerManager(config(), resolver);

    try {
        const backends = await manager.resolveBackends();
        assert.deepEqual(backends, [
            { id: 'rtpbridge-0.svc.local', url: 'ws://rtpbridge-0.svc.local:9100', httpUrl: 'http://rtpbridge-0.svc.local:9100' },
            { id: 'rtpbridge-2.svc.local', url: 'ws://rtpbridge-2.svc.local:9100', httpUrl: 'http://rtpbridge-2.svc.local:9100' }
        ]);
        assert.equal(resolver.srvQueries[0], '_ws._tcp.rtpbridge.default.svc');
    } finally {
        manager.destroy();
    }
});

test('media server manager pins calls idempotently to a selected backend', async () => {
    const manager = new MediaServerManager(config(), new FakeResolver({
        srv: [{ name: 'rtpbridge-0.svc.local.' }, { name: 'rtpbridge-1.svc.local.' }]
    }));

    try {
        const first = await manager.pickBackendForCall('call-1');
        const again = await manager.pickBackendForCall('call-1');
        const secondCall = await manager.pickBackendForCall('call-2');

        assert.equal(first, 'rtpbridge-0.svc.local');
        assert.equal(again, first);
        assert.equal(secondCall, 'rtpbridge-1.svc.local');
    } finally {
        manager.destroy();
    }
});

test('media server manager keeps shared call pins until all references are released', async () => {
    const manager = new MediaServerManager(config(), new FakeResolver({
        srv: [{ name: 'rtpbridge-0.svc.local.' }, { name: 'rtpbridge-1.svc.local.' }]
    }));

    try {
        manager.registerCall('call-1', 'rtpbridge-0.svc.local');
        manager.registerCall('call-1', 'rtpbridge-0.svc.local');
        assert.equal(manager.getBackendForCall('call-1'), 'rtpbridge-0.svc.local');

        manager.unregisterCall('call-1', 'rtpbridge-0.svc.local');
        assert.equal(manager.getBackendForCall('call-1'), 'rtpbridge-0.svc.local');

        manager.unregisterCall('call-1', 'rtpbridge-0.svc.local');
        assert.equal(manager.getBackendForCall('call-1'), undefined);
    } finally {
        manager.destroy();
    }
});

test('media server manager can move a released agent session to the next backend', async () => {
    const manager = new MediaServerManager(
        config(),
        new FakeResolver({
            srv: [{ name: 'rtpbridge-0.svc.local.' }, { name: 'rtpbridge-1.svc.local.' }]
        })
    );

    try {
        const first = await manager.createClient({ callId: 'agent-10-20' });
        assert.equal(first.backendId, 'rtpbridge-0.svc.local');
        manager.unregisterCall('agent-10-20', first.backendId);
        first.close();

        const replacement = await manager.createClient({ callId: 'agent-10-20' });
        assert.equal(replacement.backendId, 'rtpbridge-1.svc.local');
        manager.unregisterCall('agent-10-20', replacement.backendId);
        replacement.close();
    } finally {
        manager.destroy();
    }
});

test('media server manager falls back to A records when SRV lookup fails', async () => {
    const manager = new MediaServerManager(config(), new FakeResolver({
        srvError: new Error('ENOTFOUND'),
        a: ['10.0.0.2', '10.0.0.1']
    }));

    try {
        assert.deepEqual(await manager.resolveBackends(), [
            { id: '10.0.0.1', url: 'ws://10.0.0.1:9100', httpUrl: 'http://10.0.0.1:9100' },
            { id: '10.0.0.2', url: 'ws://10.0.0.2:9100', httpUrl: 'http://10.0.0.2:9100' }
        ]);
    } finally {
        manager.destroy();
    }
});

class FakeResolver implements MediaServerResolver {
    srvQueries: string[] = [];

    constructor(private responses: { srv?: Array<{ name: string }>; srvError?: Error; a?: string[] }) { }

    async resolveSrv(name: string) {
        this.srvQueries.push(name);
        if (this.responses.srvError) throw this.responses.srvError;
        return this.responses.srv ?? [];
    }

    async resolve4() {
        return this.responses.a ?? [];
    }
}

function config(): Pick<
    GatewayConfig,
    'RTPBRIDGE_HOST' | 'RTPBRIDGE_PORT' | 'RTPBRIDGE_SRV_PORT_NAME' | 'RTPBRIDGE_REQUEST_TIMEOUT_MS' | 'RTPBRIDGE_CONNECTION_TIMEOUT_MS'
> {
    return {
        RTPBRIDGE_HOST: 'rtpbridge.default.svc',
        RTPBRIDGE_PORT: 9100,
        RTPBRIDGE_SRV_PORT_NAME: 'ws',
        RTPBRIDGE_REQUEST_TIMEOUT_MS: 10_000,
        RTPBRIDGE_CONNECTION_TIMEOUT_MS: 5_000
    };
}
