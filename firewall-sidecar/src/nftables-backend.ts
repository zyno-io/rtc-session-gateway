import type { FirewallBackend } from '../../src/firewall-reconciler';

export class NftablesFirewallBackend implements FirewallBackend {
    private manager?: import('nftables-napi').NftManager;
    constructor(private readonly table: string) {
        if (!/^[a-z][a-z0-9_]{0,27}$/.test(table)) throw new Error('Invalid firewall table name');
    }
    async reset(): Promise<void> {
        if (process.platform !== 'linux') throw new Error('Native firewall requires Linux');
        // The native addon exposes its constructor through CommonJS; Node's synthetic ESM
        // named exports do not include it. Load only inside the Linux sidecar.
        const native: typeof import('nftables-napi') = require('nftables-napi');
        this.manager = new native.NftManager({
            tableName: this.table,
            ingressAddrSets: ['banned'],
            logging: false,
            acceptReplyTraffic: false
        });
        await this.manager.createTable();
    }
    async add(target: string, ttlSeconds: number): Promise<void> {
        if (!this.manager) throw new Error('Firewall backend not initialized');
        await this.manager.addAddress({ ip: target, set: 'banned', timeout: ttlSeconds });
    }
    async remove(target: string): Promise<void> {
        if (!this.manager) throw new Error('Firewall backend not initialized');
        await this.manager.removeAddress({ ip: target, set: 'banned' });
    }
}
