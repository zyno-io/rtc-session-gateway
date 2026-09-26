import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';

// Independent test client: the production signer is deliberately not imported.
export function backendTlsOptions() {
    return {
        ca: readFileSync(process.env.RTPBRIDGE_TLS_CA_FILE),
        servername: process.env.RTPBRIDGE_TLS_SERVERNAME || 'rtpbridge.test'
    };
}

export function backendHeaders(method, url, secretOverride) {
    const target = new URL(url);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = secretOverride ?? readFileSync(process.env.RTPBRIDGE_AUTH_HMAC_SECRET_FILE).toString().replace(/[\r\n]+$/, '');
    const signature = createHmac('sha256', secret)
        .update(`rtpbridge-auth-v1\n${timestamp}\n${method}\n${target.pathname}${target.search}`)
        .digest('base64url');
    return { authorization: `HMAC-SHA256 ${timestamp}:${signature}` };
}

export async function e2eFetch(url, options = {}) {
    if (!url.startsWith('https:')) return fetch(url, { signal: AbortSignal.timeout(15_000), ...options });
    return new Promise((resolve, reject) => {
        const request = https.request(url, {
            ...backendTlsOptions(),
            method: options.method || 'GET',
            headers: options.headers ?? backendHeaders(options.method || 'GET', url),
            timeout: 15_000
        }, response => {
            const chunks = [];
            response.on('error', reject);
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    status: response.statusCode,
                    text: async () => body.toString(),
                    arrayBuffer: async () => body,
                    headers: { get: name => response.headers[name.toLowerCase()] }
                });
            });
        });
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error(`HTTP timeout: ${url}`)));
        request.end(options.body);
    });
}
