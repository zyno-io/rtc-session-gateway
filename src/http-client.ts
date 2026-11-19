import axios, { isAxiosError } from 'axios';

export interface GatewayHttpClient {
    postJson<T>(url: string, body: unknown, timeoutMs: number, options?: PostJsonOptions): Promise<T>;
}

export interface PostJsonOptions {
    /** The response body is never used: consume nothing and destroy the stream as soon as headers arrive. */
    discardBody?: boolean;
}

/** Cap for JSON action responses (and request bodies). Enforced by axios after decompression, so compressed bombs are bounded too. */
export const MAX_HTTP_JSON_BYTES = 1024 * 1024;

export class AxiosGatewayHttpClient implements GatewayHttpClient {
    async postJson<T>(url: string, body: unknown, timeoutMs: number, options: PostJsonOptions = {}) {
        // axios' own timeout stops applying once response headers arrive, so a body that trickles forever would never settle.
        // One wall-clock deadline aborts the whole exchange, response-body consumption included.
        const controller = new AbortController();
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            controller.abort();
        }, timeoutMs);
        try {
            const response = await axios.post<T>(url, body, {
                timeout: timeoutMs,
                signal: controller.signal,
                maxContentLength: MAX_HTTP_JSON_BYTES,
                maxBodyLength: MAX_HTTP_JSON_BYTES,
                ...(options.discardBody ? { responseType: 'stream' as const } : {}),
                validateStatus: status => status >= 200 && status < 300
            });
            if (options.discardBody) {
                (response.data as unknown as { destroy?: () => void })?.destroy?.();
                return undefined as T;
            }
            return response.data;
        } catch (err) {
            if (isAxiosError(err)) {
                if (expired) {
                    throw new HttpPostError(`HTTP POST ${url} failed`, { cause: err, code: 'ECONNABORTED', status: err.response?.status });
                }
                throw new HttpPostError(`HTTP POST ${url} failed`, {
                    cause: err,
                    code: err.code,
                    status: err.response?.status
                });
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }
}

export class HttpPostError extends Error {
    code?: string;
    status?: number;

    constructor(message: string, options: { cause: unknown; code?: string; status?: number }) {
        super(message, { cause: options.cause });
        this.code = options.code;
        this.status = options.status;
    }
}
