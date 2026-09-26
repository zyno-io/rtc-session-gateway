import pino from 'pino';

const logStream =
    process.env.NODE_ENV === 'production'
        ? pino.multistream(
            [
                { level: 'debug', stream: process.stdout },
                { level: 'error', stream: process.stderr }
            ],
            { dedupe: true }
        )
        : // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('pino-pretty').default({
            colorize: true,
            singleLine: true,
            levelFirst: true,
            customColors: 'alert:bgRed,error:red,warning:yellow,notice:green,info:blue,debug:gray,default:white'
        });

export const BaseLogger = pino({ level: process.env.DEBUG ? 'debug' : 'info' }, logStream);
