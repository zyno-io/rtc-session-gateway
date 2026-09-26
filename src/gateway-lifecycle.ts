import { EventEmitter } from 'node:events';

import { BaseLogger } from './logger';

export class GatewayDrainingError extends Error {
    constructor() {
        super('Gateway is draining; send new calls and sessions to another instance');
    }
}

export class GatewayLifecycle extends EventEmitter {
    private logger = BaseLogger.child({ ns: 'GatewayLifecycle' });
    private pendingOperations = 0;
    private completion?: Promise<void>;
    private resolveCompletion?: () => void;
    private pollTimer?: NodeJS.Timeout;
    private deadlineTimer?: NodeJS.Timeout;
    isDraining = false;
    isStopping = false;

    constructor(private options: {
        maxWaitMs: number;
        cleanupTimeoutMs: number;
        activeResources: () => number;
        stop: (forced: boolean) => Promise<void>;
    }) {
        super();
    }

    assertAccepting() {
        if (this.isDraining) throw new GatewayDrainingError();
    }

    assertRunning() {
        if (this.isStopping) throw new GatewayDrainingError();
    }

    beginOperation() {
        this.assertRunning();
        this.pendingOperations++;
        let finished = false;
        return () => {
            if (finished) return;
            finished = true;
            this.pendingOperations--;
        };
    }

    async track<T>(operation: () => Promise<T>): Promise<T> {
        const finish = this.beginOperation();
        try {
            return await operation();
        } finally {
            finish();
        }
    }

    drain(reason: string): Promise<void> {
        if (this.completion) return this.completion;
        this.isDraining = true;
        this.completion = new Promise(resolve => { this.resolveCompletion = resolve; });
        this.logger.info({ reason, maxWaitMs: this.options.maxWaitMs }, 'Gateway draining');
        this.emit('draining', { reason, maxWaitMs: this.options.maxWaitMs });
        // Schedule the first check so the initiating HTTP response can finish.
        this.pollTimer = setInterval(() => {
            if (this.pendingOperations === 0 && this.options.activeResources() === 0) void this.stop(false);
        }, 100);
        this.deadlineTimer = setTimeout(() => { void this.stop(true); }, this.options.maxWaitMs);
        return this.completion;
    }

    private async stop(forced: boolean) {
        if (this.isStopping) return;
        this.isStopping = true;
        clearInterval(this.pollTimer);
        clearTimeout(this.deadlineTimer);
        this.logger.info({ forced, pendingOperations: this.pendingOperations, activeResources: this.options.activeResources() }, 'Gateway stopping');
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                this.options.stop(forced),
                new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.cleanupTimeoutMs); })
            ]);
        } catch (err) {
            this.logger.error({ err }, 'Gateway shutdown cleanup failed');
        } finally {
            clearTimeout(timer);
            this.resolveCompletion?.();
            this.emit('stopped');
        }
    }
}
