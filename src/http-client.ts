import axios, { isAxiosError } from 'axios';

export interface GatewayHttpClient {
    postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T>;
}

export class AxiosGatewayHttpClient implements GatewayHttpClient {
    async postJson<T>(url: string, body: unknown, timeoutMs: number) {
        try {
            const response = await axios.post<T>(url, body, {
                timeout: timeoutMs,
                validateStatus: status => status >= 200 && status < 300
            });
            return response.data;
        } catch (err) {
            if (isAxiosError(err)) {
                throw new HttpPostError(`HTTP POST ${url} failed`, {
                    cause: err,
                    code: err.code,
                    status: err.response?.status
                });
            }
            throw err;
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
