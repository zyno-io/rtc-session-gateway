import pino from 'pino';

function prettyStream() {
    if (process.env.NODE_ENV === 'production') return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('pino-pretty').default({
            colorize: true,
            singleLine: true,
            levelFirst: true,
            customColors: 'alert:bgRed,error:red,warning:yellow,notice:green,info:blue,debug:gray,default:white'
        });
    } catch {
        // Images without the dev-only pretty printer (e.g. the firewall sidecar) fall back to JSON.
        return undefined;
    }
}

const logStream =
    prettyStream() ??
    pino.multistream(
        [
            { level: 'debug', stream: process.stdout },
            { level: 'error', stream: process.stderr }
        ],
        { dedupe: true }
    );

export const BaseLogger = pino({ level: process.env.DEBUG ? 'debug' : 'info' }, logStream);
