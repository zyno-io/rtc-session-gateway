/** Keep the SDP origin and media ordering of an established dialog across relayed offers. */
export function relaySdp(remoteSdp: string, previousLocalSdp?: string): string {
    const lines = remoteSdp.trim().split(/\r?\n/);
    const originIndex = lines.findIndex(line => line.startsWith('o='));
    const media = lines.filter(line => line.startsWith('m='));
    if (lines[0] !== 'v=0' || originIndex < 0 || !media.length) throw new Error('Invalid session description');
    const previous = previousLocalSdp?.trim().split(/\r?\n/);
    if (previous) {
        const oldMedia = previous.filter(line => line.startsWith('m='));
        if (oldMedia.length !== media.length || oldMedia.some((line, i) => line.split(' ')[0] !== media[i].split(' ')[0])) {
            throw new Error('Handoff cannot change the established media-section ordering');
        }
        const origin = previous.find(line => line.startsWith('o='))?.split(/\s+/);
        if (!origin || origin.length !== 6 || !/^\d+$/.test(origin[2])) throw new Error('Invalid established SDP origin');
        origin[2] = String(BigInt(origin[2]) + 1n);
        lines[originIndex] = origin.join(' ');
    }
    return lines.join('\r\n') + '\r\n';
}

export function rejectSdpOffer(sdp: string): string {
    return relaySdp(sdp).replace(/^m=(\S+) \d+/gm, 'm=$1 0');
}

/** A rejected audio stream or an incompatible answer cannot be a successful handoff. */
export function assertDirectMediaAnswer(offer: string, answer: string) {
    const sections = (sdp: string) =>
        sdp
            .trim()
            .split(/\r?\n/)
            .filter(line => line.startsWith('m='))
            .map(line => line.slice(2).split(/\s+/));
    relaySdp(answer, offer); // Validate SDP structure and corresponding media sections.
    const offered = sections(offer);
    const accepted = sections(answer);
    if (!accepted.some(media => media[0] === 'audio' && Number(media[1]) > 0)) throw new Error('Destination audio was rejected');
    for (const [index, media] of accepted.entries()) {
        if (Number(media[1]) === 0) continue;
        const source = offered[index];
        if (
            !Number(source[1]) ||
            media[2] !== source[2] ||
            !media.slice(3).length ||
            media.slice(3).some(codec => !source.slice(3).includes(codec))
        ) {
            throw new Error('Incompatible direct media answer');
        }
    }
    mediaAddressKey(answer);
}

export function mediaAddressKey(sdp: string): string {
    const lines = sdp.trim().split(/\r?\n/);
    let connection = '';
    const media: string[][] = [];
    for (const line of lines) {
        if (line.startsWith('m=')) {
            const [type, port, protocol] = line.slice(2).split(/\s+/);
            media.push([type, port, protocol, connection]);
        } else if (line.startsWith('c=')) {
            if (media.length) media[media.length - 1][3] = line.slice(2);
            else connection = line.slice(2);
        }
    }
    if (!media.length || media.some(item => !item[3])) throw new Error('Missing media address');
    return JSON.stringify(media);
}

export interface ReplacesIdentity {
    callId: string;
    toTag: string;
    fromTag: string;
    earlyOnly: boolean;
}

export function parseReplaces(value: string): ReplacesIdentity {
    const [callId, ...parameters] = value.split(';');
    const values = new Map<string, string>();
    for (const parameter of parameters) {
        const [key, ...parts] = parameter.trim().split('=');
        const normalized = key.toLowerCase();
        if (values.has(normalized)) throw new Error('Duplicate Replaces parameter');
        values.set(normalized, parts.join('='));
    }
    const toTag = values.get('to-tag');
    const fromTag = values.get('from-tag');
    if (!callId.trim() || !toTag || !fromTag || /[\s\r\n]/.test(callId + toTag + fromTag)) throw new Error('Invalid Replaces header');
    return { callId: callId.trim(), toTag, fromTag, earlyOnly: values.has('early-only') };
}
