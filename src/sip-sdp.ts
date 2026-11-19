import { isIP } from 'node:net';

import { sourceIp } from './firewall-address';

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

const EMPTY_REJECTION_SDP = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\n';

/**
 * Builds the answer that declines every stream of an offer. Never throws: sipbridge treats any non-empty SDP body as an
 * offer that needs an ACK answer, so an unparsable offer must still be acknowledged (with a minimal valid SDP).
 */
export function rejectSdpOffer(sdp: string): string {
    try {
        return relaySdp(sdp).replace(/^m=(\S+) \d+/gm, 'm=$1 0');
    } catch {
        return EMPTY_REJECTION_SDP;
    }
}

interface MediaSection {
    type: string;
    port: number;
    protocol: string;
    formats: string[];
    connection: string;
    direction: string;
    /** Payload type to lowercase `encoding/clock`. */
    rtpmap: Map<string, string>;
    /** Payload type to normalized fmtp parameters (lowercase, sorted `key=value` pairs joined by `;`). */
    fmtp: Map<string, string>;
    /** SDES `suite key-params` of every a=crypto line (the tag is not part of the key identity). */
    crypto: Set<string>;
}

const DIRECTIONS = new Set(['sendrecv', 'sendonly', 'recvonly', 'inactive']);

function parseMediaSections(sdp: string): MediaSection[] {
    const sections: MediaSection[] = [];
    let sessionConnection = '';
    let sessionDirection = '';
    let current: MediaSection | undefined;
    for (const line of sdp.trim().split(/\r?\n/)) {
        if (line.startsWith('m=')) {
            const [type, port, protocol, ...formats] = line.slice(2).trim().split(/\s+/);
            current = {
                type,
                port: Number(port),
                protocol,
                formats,
                connection: '',
                direction: '',
                rtpmap: new Map(),
                fmtp: new Map(),
                crypto: new Set()
            };
            sections.push(current);
        } else if (line.startsWith('c=')) {
            if (current) current.connection = line.slice(2).trim();
            else sessionConnection = line.slice(2).trim();
        } else if (line.startsWith('a=')) {
            const attribute = line.slice(2).trim();
            if (DIRECTIONS.has(attribute)) {
                if (current) current.direction = attribute;
                else sessionDirection = attribute;
            } else if (current && attribute.startsWith('crypto:')) {
                const [, suite, params] = attribute.split(/\s+/);
                if (suite && params) current.crypto.add(`${suite} ${params}`);
            } else if (current && attribute.startsWith('rtpmap:')) {
                const match = /^rtpmap:(\d+)\s+([^/\s]+)\/(\d+)/.exec(attribute);
                if (match) current.rtpmap.set(match[1], `${match[2].toLowerCase()}/${match[3]}`);
            } else if (current && attribute.startsWith('fmtp:')) {
                const match = /^fmtp:(\d+)\s+(.*)$/.exec(attribute);
                if (match) {
                    const params = match[2]
                        .split(';')
                        .map(part =>
                            part
                                .trim()
                                .toLowerCase()
                                .replace(/\s*=\s*/, '=')
                        )
                        .filter(Boolean)
                        .sort();
                    current.fmtp.set(match[1], params.join(';'));
                }
            }
        }
    }
    for (const section of sections) {
        section.connection ||= sessionConnection;
        section.direction ||= sessionDirection || 'sendrecv';
    }
    return sections;
}

/** Formats that carry signalling or repair data, never voice (matched by lowercase rtpmap encoding name). */
const NON_VOICE_ENCODINGS = new Set(['telephone-event', 'cn', 'red', 'ulpfec', 'flexfec', 'flexfec-03', 'rtx']);

/** True when the payload type is a real voice codec: not telephone-event, CN (static PT 13), red, ulpfec, flexfec or rtx. */
function isVoiceFormat(section: MediaSection, pt: string, offered?: MediaSection): boolean {
    // A payload type the answer leaves unmapped keeps the meaning the offer gave it (RFC 3264 6.1).
    const encoding = (section.rtpmap.get(pt) ?? offered?.rtpmap.get(pt))?.split('/')[0];
    if (encoding) return !NON_VOICE_ENCODINGS.has(encoding);
    return pt !== '13';
}

/**
 * True when the two sections share a real voice codec, matched by payload type number or (renumbered dynamic types) by
 * encoding and clock. telephone-event and comfort noise alone never make two streams compatible.
 */
function sharesFormat(offered: MediaSection, answered: MediaSection): boolean {
    return answered.formats.some(pt => {
        if (!isVoiceFormat(answered, pt, offered)) return false;
        if (offered.formats.includes(pt)) {
            const left = offered.rtpmap.get(pt);
            const right = answered.rtpmap.get(pt);
            // A dynamic type bound to different encodings is not the same format.
            if (!left || !right || left === right || Number(pt) < 96) return true;
        }
        const encoding = answered.rtpmap.get(pt);
        return !!encoding && offered.formats.some(other => offered.rtpmap.get(other) === encoding);
    });
}

const STATIC_ENCODINGS: Record<string, string> = {
    '0': 'pcmu/8000',
    '3': 'gsm/8000',
    '4': 'g723/8000',
    '8': 'pcma/8000',
    '9': 'g722/8000',
    '18': 'g729/8000'
};

/**
 * Identity of a payload type: static types are `encoding/clock`, dynamic ones `pt:encoding/clock|fmtp`. Static types (< 96) have a fixed meaning
 * (RFC 3551), so any rtpmap is ignored for them on both sides; a dynamic type unmapped in `section` takes the mapping of
 * `fallbacks` (RFC 3264 6.1: an answer keeps the meaning the offer gave a type it leaves unmapped).
 */
function codecIdentity(section: MediaSection, pt: string, ...fallbacks: (MediaSection | undefined)[]): string {
    if (Number(pt) < 96) return STATIC_ENCODINGS[pt] ?? `static:${pt}`;
    const sources = [section, ...fallbacks];
    const mapped = sources.map(source => source?.rtpmap.get(pt)).find(Boolean);
    const fmtp = sources.map(source => source?.fmtp.get(pt)).find(value => value !== undefined) ?? '';
    // A dynamic type is only the same codec when its number and format parameters agree (AMR 97 octet-align=0 is not 98 octet-align=1).
    return `${pt}:${mapped ?? 'dynamic'}|${fmtp}`;
}

/** The set of voice-codec identities of a stream (telephone-event, CN and repair formats excluded). */
function voiceCodecs(section: MediaSection, ...fallbacks: (MediaSection | undefined)[]): Set<string> {
    const found = new Set<string>();
    for (const pt of section.formats) {
        if (
            isVoiceFormat(
                section,
                pt,
                fallbacks.find(other => other?.rtpmap.has(pt))
            )
        )
            found.add(codecIdentity(section, pt, ...fallbacks));
    }
    return found;
}

/**
 * The voice codecs the untouched leg and the carrier negotiated on each audio stream both still use: the
 * intersection of the leg's description and the carrier's previous one.
 */
function negotiatedVoiceCodecs(leg: string, previousRemoteSdp: string): Map<number, Set<string>> {
    const negotiated = new Map<number, Set<string>>();
    const before = parseMediaSections(previousRemoteSdp);
    for (const [index, section] of parseMediaSections(leg).entries()) {
        const other = before[index];
        if (section.type !== 'audio' || !(section.port > 0) || !other || !(other.port > 0)) continue;
        const theirs = voiceCodecs(other, section);
        negotiated.set(index, new Set([...voiceCodecs(section, other)].filter(identity => theirs.has(identity))));
    }
    return negotiated;
}

/**
 * A rejected audio stream or an incompatible answer cannot be a successful handoff. The answer may list additional
 * formats it can receive (RFC 3264 6.1) but must keep at least one of the offered formats on every active stream.
 */
export function assertDirectMediaAnswer(offer: string, answer: string) {
    relaySdp(answer, offer); // Validate SDP structure and corresponding media sections.
    const offered = parseMediaSections(offer);
    const accepted = parseMediaSections(answer);
    if (!accepted.some(media => media.type === 'audio' && media.port > 0)) throw new Error('Destination audio was rejected');
    for (const [index, media] of accepted.entries()) {
        if (media.port === 0) continue;
        const source = offered[index];
        if (!source.port || media.protocol !== source.protocol || !sharesFormat(source, media)) {
            throw new Error('Incompatible direct media answer');
        }
    }
    mediaAddressKey(answer);
}

/** RFC 3264 6.1: the answer direction that keeps the media flow the offer asked for. */
const ANSWER_DIRECTION: Record<string, string> = {
    sendrecv: 'sendrecv',
    sendonly: 'recvonly',
    recvonly: 'sendonly',
    inactive: 'inactive'
};

/**
 * Validates a rollback answer to `restoreOffer`. The restored side keeps sending media to the carrier address it
 * already holds, so every stream both sides still use must keep that address and port, keep the direction the offer
 * asked for (an answer that turns a bidirectional stream into inactive or one-way leaves the call on hold), and at
 * least one audio stream must remain active. Streams the restore offer declined (port 0) are not compared. Extra
 * payload types are allowed (RFC 3264 6.1); anything that changes the carrier's media address cannot be repaired.
 * SDES keys cannot be re-derived by the restored side: an active stream whose previous carrier description had
 * a=crypto must answer only with keys it already had.
 * The restore offer is the untouched leg's own description, so the answer's voice codecs must equal, per stream, the
 * set negotiated before (the voice codecs in both `restoreOffer` and `previousRemoteSdp`; dynamic types by number and fmtp):
 * dropping one leaves the untouched leg sending a format nobody expects, and adding one the untouched leg may not decode.
 * Non-voice formats (telephone-event, CN) are ignored.
 */
export function assertRollbackAnswer(answer: string, previousRemoteSdp: string, restoreOffer: string) {
    const restored = parseMediaSections(restoreOffer);
    const answered = parseMediaSections(answer);
    const previous = parseMediaSections(previousRemoteSdp);
    if (answered.length !== restored.length) throw new Error('Rollback answer changed the media sections');
    let audioActive = false;
    for (const [index, media] of answered.entries()) {
        const offered = restored[index];
        if (!(offered.port > 0) || !(media.port > 0)) continue;
        if (!media.connection) throw new Error('Missing media address');
        const before = previous[index];
        if (!before || before.port !== media.port || before.protocol !== media.protocol || before.connection !== media.connection) {
            throw new Error('Rollback changed the carrier media address');
        }
        if (media.direction !== ANSWER_DIRECTION[offered.direction]) throw new Error('Rollback did not restore the media direction');
        if (before.crypto.size && (!media.crypto.size || [...media.crypto].some(key => !before.crypto.has(key)))) {
            throw new Error('Rollback changed the SDES crypto keys');
        }
        if (media.type === 'audio') audioActive = true;
    }
    if (!audioActive) throw new Error('Rollback audio was rejected');
    // The other leg keeps using the codecs it negotiated: the restored answer must offer exactly that voice set.
    for (const [index, expected] of negotiatedVoiceCodecs(restoreOffer, previousRemoteSdp)) {
        const media = answered[index];
        if (!media || !(media.port > 0) || !expected.size) continue;
        const actual = voiceCodecs(media, restored[index]);
        if (actual.size !== expected.size || [...actual].some(identity => !expected.has(identity))) {
            throw new Error('Rollback answer changed the negotiated voice codecs of the other leg');
        }
    }
}

/** `IN IP6 2001:0db8::10/127` -> comparable `ip6 2001:db8:0:0:0:0:0:10`: spelling, brackets, TTL suffix and ::ffff: forms collapse. */
function canonicalConnection(connection: string): string {
    const [nettype, addrtype, address = ''] = connection.trim().split(/\s+/);
    const host = address.split('/')[0].replace(/^\[(.*)\]$/, '$1');
    const canonical = sourceIp(host);
    // A mapped IPv6 address canonicalizes to its IPv4 form, which is the same endpoint.
    return canonical ? canonical : `${nettype}|${addrtype}|${host.toLowerCase()}`.toLowerCase();
}

/**
 * True when an active stream's connection address is not an IP literal. A hostname cannot be compared to another
 * description without resolving it, so endpoint exclusivity cannot be established for such media.
 */
export function usesHostnameMedia(sdp: string): boolean {
    let session = '';
    let current: { port: number; connection: string } | undefined;
    let found = false;
    const flush = () => {
        if (!current || !(current.port > 0) || !current.connection) return;
        const host = (current.connection.trim().split(/\s+/)[2] ?? '')
            .split('/')[0]
            .replace(/^\[(.*)\]$/, '$1')
            .split('%')[0];
        if (host && !isIP(host)) found = true;
    };
    for (const line of sdp.trim().split(/\r?\n/)) {
        if (line.startsWith('m=')) {
            flush();
            current = { port: Number(line.slice(2).split(/\s+/)[1]), connection: session };
        } else if (line.startsWith('c=')) {
            if (current) current.connection = line.slice(2).trim();
            else session = line.slice(2).trim();
        }
    }
    flush();
    return found;
}

/** True when two session descriptions send media to a common address and port (an RTP endpoint shared by two calls). */
export function sharesMediaEndpoint(a: string, b: string): boolean {
    const endpoints = (sdp: string) => {
        const found = new Set<string>();
        let session = '';
        let current: { port: string; connection: string } | undefined;
        const flush = () => {
            const port = Number(current?.port);
            if (current && port > 0 && current.connection) found.add(`${canonicalConnection(current.connection)}|${port}`);
        };
        for (const line of sdp.trim().split(/\r?\n/)) {
            if (line.startsWith('m=')) {
                flush();
                current = { port: line.slice(2).split(/\s+/)[1] ?? '', connection: session };
            } else if (line.startsWith('c=')) {
                if (current) current.connection = line.slice(2).trim();
                else session = line.slice(2).trim();
            }
        }
        flush();
        return found;
    };
    const left = endpoints(a);
    for (const endpoint of endpoints(b)) if (left.has(endpoint)) return true;
    return false;
}

/**
 * True when `next` keeps every media parameter a peer negotiated against `previous`: address/port/protocol, direction,
 * SDES keys and voice codec identities on each stream. Anything else needs a renegotiation.
 */
export function preservesMediaParameters(previous: string, next: string): boolean {
    try {
        if (mediaAddressKey(previous) !== mediaAddressKey(next)) return false;
    } catch {
        return false;
    }
    const before = parseMediaSections(previous);
    const after = parseMediaSections(next);
    if (before.length !== after.length) return false;
    return before.every((media, index) => {
        const other = after[index];
        if (media.direction !== other.direction) return false;
        if (media.crypto.size !== other.crypto.size || [...media.crypto].some(key => !other.crypto.has(key))) return false;
        const left = voiceCodecs(media);
        const right = voiceCodecs(other);
        return left.size === right.size && [...left].every(identity => right.has(identity));
    });
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

/** Splits on `;` outside quoted strings (RFC 3261 25.1). Throws on an unterminated quote. */
function splitOutsideQuotes(value: string, separator: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quoted && char === '\\') {
            current += char + (value[++i] ?? '');
            continue;
        }
        if (char === '"') quoted = !quoted;
        if (char === separator && !quoted) {
            parts.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    if (quoted) throw new Error('Unterminated quoted string in Replaces');
    parts.push(current);
    return parts;
}

const TOKEN = /^[A-Za-z0-9\-.!%*_+`'~]+$/;
/** host = hostname / IPv4address / IPv6reference (RFC 3261 25.1); a hostname is already a token, so only `[IPv6]` is extra. A port is not part of host. */
const IPV6_REFERENCE = /^\[[A-Fa-f0-9:.]+\]$/;
const isGenValue = (value: string) => TOKEN.test(value) || (IPV6_REFERENCE.test(value) && isIP(value.slice(1, -1)) === 6);
const QUOTED_STRING = /^"(?:[^"\\\r\n]|\\.)*"$/;

export function parseReplaces(value: string): ReplacesIdentity {
    // A Call-ID word may contain a DQUOTE but never `;`, so split it off before any quote-aware parameter parsing.
    const first = value.indexOf(';');
    const callId = (first < 0 ? value : value.slice(0, first)).trim(); // SEMI = SWS ";" SWS
    const parameters = first < 0 ? [] : splitOutsideQuotes(value.slice(first + 1), ';');
    const values = new Map<string, string | undefined>();
    for (const [position, parameter] of parameters.entries()) {
        if (!parameter.trim() && position === parameters.length - 1) continue; // tolerate one trailing `;`
        // generic-param = token [ EQUAL gen-value ]; gen-value = token / host / quoted-string
        const separator = parameter.indexOf('=');
        const key = (separator < 0 ? parameter : parameter.slice(0, separator)).trim();
        const generic = separator < 0 ? undefined : parameter.slice(separator + 1).trim();
        if (
            !TOKEN.test(key) ||
            (generic !== undefined && !generic.startsWith('"') && !isGenValue(generic)) ||
            (generic?.startsWith('"') && !QUOTED_STRING.test(generic))
        ) {
            throw new Error('Invalid Replaces parameter');
        }
        const normalized = key.toLowerCase();
        if (values.has(normalized)) throw new Error('Duplicate Replaces parameter');
        values.set(normalized, generic);
    }
    const toTag = values.get('to-tag');
    const fromTag = values.get('from-tag');
    if (!callId.trim() || !toTag || !fromTag || /[\s\r\n]/.test(callId + toTag + fromTag)) throw new Error('Invalid Replaces header');
    // early-only is a flag: only the bare parameter name sets it, never a value or text inside a quoted string.
    return { callId: callId.trim(), toTag, fromTag, earlyOnly: values.has('early-only') && values.get('early-only') === undefined };
}

export interface ReferTarget {
    uri: string;
    replaces?: ReplacesIdentity;
}

/**
 * Parses a Refer-To value (name-addr or addr-spec) into its SIP URI and an optional Replaces identity.
 * The URI keeps its headers off so it can be used as a route destination. Throws on malformed input.
 */
export function parseReferTarget(value: string): ReferTarget {
    const trimmed = value.trim();
    const uri = (/<([^>]+)>/.exec(trimmed)?.[1] ?? trimmed.split(';')[0]).trim();
    const match = /^(sips?):([^\s?<>]+)(?:\?(.*))?$/i.exec(uri);
    if (!match || !match[2].replace(/^[^@]*@/, '').split(/[;:]/)[0]) throw new Error('Invalid SIP target');
    let replaces: ReplacesIdentity | undefined;
    for (const header of (match[3] ?? '').split('&').filter(Boolean)) {
        const [name, ...rest] = header.split('=');
        if (name.toLowerCase() !== 'replaces') continue;
        if (replaces) throw new Error('Duplicate Replaces header');
        replaces = parseReplaces(decodeURIComponent(rest.join('=')));
    }
    return { uri: `${match[1].toLowerCase()}:${match[2]}`, replaces };
}
