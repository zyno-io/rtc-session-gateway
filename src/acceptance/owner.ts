import { randomUUID, createHash } from 'node:crypto';
import { AcceptanceError, type OwnerConnection } from './client';
import type { ControlRequest, ControlEvent } from '../control-protocol';

type Call = { ended: boolean; media?: string; endpoint?: string; recording?: string; tail: Promise<unknown>; cleanup?: Promise<void> };
export class AcceptanceOwner {
    private calls = new Map<string, Call>();
    private receipts = new Map<string, { fingerprint: string; result: Promise<unknown>; expires: number }>();
    readonly counters = { invites: 0, answered: 0, rejected: 0, reinvites: 0, ended: 0, errors: 0, draining: false };
    constructor(
        private client: OwnerConnection,
        readonly route: string,
        private prefix = 'sg_acceptance_'
    ) {
        if (!/^rtc-acceptance(?:-[a-z0-9]+)*$/.test(route) || route.length > 80) throw new AcceptanceError('INVALID_TEST_ROUTE');
        if (!/^[A-Za-z0-9_]{1,40}$/.test(prefix)) throw new AcceptanceError('INVALID_RECORDING_PREFIX');
    }
    async register() {
        await this.client.request('route.register', {
            routes: [
                { match: 'exact', value: this.route },
                { match: 'exact', value: this.route + '-reject' }
            ]
        });
    }
    async handle(request: ControlRequest) {
        const now = Date.now();
        for (const [id, entry] of this.receipts) if (entry.expires < now) this.receipts.delete(id);
        const fingerprint = createHash('sha256')
            .update(JSON.stringify([request.method, request.params]))
            .digest('hex');
        const previous = this.receipts.get(request.id);
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw new AcceptanceError('REQUEST_REPLAY_MISMATCH');
            return previous.result;
        }
        if (this.receipts.size >= 512) return { action: 'reject', status: 503 };
        const receipt = { fingerprint, result: Promise.resolve({}) as Promise<unknown>, expires: Infinity };
        this.receipts.set(request.id, receipt);
        receipt.result = this.dispatch(request)
            .catch(() => {
                this.counters.errors++;
                return { action: 'reject', status: 503 };
            })
            .finally(() => {
                receipt.expires = Date.now() + 120000;
            });
        return receipt.result;
    }
    private async dispatch(request: ControlRequest) {
        const body = request.params as Record<string, unknown>;
        if (!body || typeof body.callId !== 'string' || typeof body.sdp !== 'string' || body.sdp.length > 262144)
            return { action: 'reject', status: 400 };
        if (request.method === 'sip.invite') {
            this.counters.invites++;
            if (body.destinationUser === this.route + '-reject') {
                this.counters.rejected++;
                return { action: 'reject', status: 486 };
            }
            if (body.destinationUser !== this.route || this.calls.size >= 32 || this.counters.draining) return { action: 'reject', status: 503 };
            const call: Call = { ended: false, tail: Promise.resolve() };
            this.calls.set(body.callId, call);
            try {
                const media = await this.client.request('session.create', { callId: body.callId });
                call.media = media.sessionId;
                if (call.ended) {
                    await this.cleanup(body.callId, call);
                    return { action: 'reject', status: 487 };
                }
                const endpoint = await this.client.request('rtp.createFromOffer', { sessionId: call.media, sdp: body.sdp });
                call.endpoint = endpoint.endpointId;
                if (call.ended) {
                    await this.cleanup(body.callId, call);
                    return { action: 'reject', status: 487 };
                }
                return { action: 'answer', sdp: endpoint.sdpAnswer };
            } catch (error) {
                await this.cleanup(body.callId, call);
                if (error instanceof AcceptanceError && error.code === 'RPC_OUTCOME_UNKNOWN') this.client.close?.();
                throw error;
            }
        }
        if (request.method === 'sip.reinvite') {
            this.counters.reinvites++;
            const call = this.calls.get(body.callId);
            if (!call?.endpoint || call.ended) return { action: 'reject', status: 481 };
            const work = call.tail.then(() => this.client.request('rtp.reinvite', { endpointId: call.endpoint, sdp: body.sdp }));
            call.tail = work.catch(() => undefined);
            const result = await work;
            return { action: 'answer', sdp: result.sdpAnswer };
        }
        return { action: 'reject', status: 405 };
    }
    async event(event: ControlEvent) {
        if (event.event === 'gateway.draining') {
            this.counters.draining = true;
            return;
        }
        const body = event.data as { callId?: string } | undefined;
        if (event.event === 'sip.answered') {
            this.counters.answered++;
            return;
        }
        if (['sip.bye', 'sip.terminated'].includes(event.event) && body?.callId) {
            this.counters.ended++;
            const call = this.calls.get(body.callId);
            if (call) {
                call.ended = true;
                await this.cleanup(body.callId, call);
            }
        }
    }
    private async cleanup(id: string, call: Call) {
        if (!call.media) {
            if (this.calls.get(id) === call) this.calls.delete(id);
            return;
        }
        if (call.cleanup) return call.cleanup;
        call.cleanup = (async () => {
            try {
                if (call.recording) await this.client.request('recording.stop', { recordingId: call.recording });
                await this.client.request('session.delete', { sessionId: call.media });
            } catch (error) {
                this.counters.errors++;
                if (error instanceof AcceptanceError && error.code === 'RPC_OUTCOME_UNKNOWN') this.client.close?.();
            } finally {
                if (this.calls.get(id) === call) this.calls.delete(id);
            }
        })();
        return call.cleanup;
    }
    async smoke(scenario: 'media' | 'outbound' | 'cancel', uri?: string) {
        if (this.counters.draining) throw new AcceptanceError('GATEWAY_DRAINING');
        if (scenario !== 'media' && !uri) throw new AcceptanceError('OUTBOUND_URI_REQUIRED');
        const media = await this.client.request('session.create', {});
        let call: { sessionId: string; sdp: string } | undefined;
        const checks: string[] = [];
        const attempt = randomUUID();
        try {
            const offer = await this.client.request('rtp.createOffer', { sessionId: media.sessionId, codecs: ['PCMU'] });
            if (!offer.endpointId || !offer.sdpOffer) throw new AcceptanceError('INVALID_RTP_OFFER');
            checks.push('rtp-offer');
            if (scenario === 'media') {
                const web = await this.client.request('webrtc.createOffer', { sessionId: media.sessionId });
                if (!web.sdpOffer) throw new AcceptanceError('INVALID_WEBRTC_OFFER');
                checks.push('webrtc-offer');
                const recording = await this.client.request('recording.start', {
                    sessionId: media.sessionId,
                    filePath: this.prefix + randomUUID() + '.pcap'
                });
                await this.client.request('recording.stop', { recordingId: recording.recordingId });
                checks.push('recording-start-stop');
                if (recording.backendId && recording.recordingPath)
                    await this.client.request('recording.delete', { backendId: recording.backendId, path: recording.recordingPath });
            } else {
                const pending = this.client.request('sip.createOutbound', { requestUri: uri, sdp: offer.sdpOffer, outboundAttemptId: attempt });
                if (scenario === 'cancel') {
                    // The public attempt ID makes pre-context cancellation possible; no mutation is retried.
                    const outcome = pending.then(
                        value => ({ value }),
                        error => ({ error })
                    );
                    await this.client.request('sip.cancelOutbound', { outboundAttemptId: attempt });
                    const result = await outcome;
                    if ('value' in result) {
                        call = result.value;
                        throw new AcceptanceError('CALL_ANSWERED_BEFORE_CANCEL');
                    }
                    if (!(result.error instanceof AcceptanceError) || !['CONFLICT', 'NOT_FOUND'].includes(result.error.code)) throw result.error;
                    checks.push('outbound-cancel');
                } else {
                    call = await pending;
                    await this.client.request('rtp.acceptAnswer', { endpointId: offer.endpointId, sdp: call!.sdp });
                    checks.push('outbound-answer');
                    await this.client.request('sip.reinvite', { sessionId: call!.sessionId, sdp: offer.sdpOffer });
                    checks.push('reinvite');
                }
            }
            return { checks, scope: 'control-plane-smoke-no-audio-proof' };
        } finally {
            try {
                if (call) await this.client.request('sip.bye', { sessionId: call.sessionId });
            } finally {
                await this.client.request('session.delete', { sessionId: media.sessionId });
            }
        }
    }
    async stop() {
        this.counters.draining = true;
        await this.client.request('route.register', { routes: [] }).catch(() => undefined);
        await Promise.allSettled(
            [...this.calls].map(async ([id, call]) => {
                call.ended = true;
                await this.client.request('sip.bye', { sessionId: id }).catch(() => undefined);
                await this.cleanup(id, call);
            })
        );
    }
    get activeCalls() {
        return this.calls.size;
    }
}
