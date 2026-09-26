import assert from 'node:assert/strict';

// Generate a deterministic 440 Hz PCMU tone, then decode captured bytes
// independently so silence, corrupt payloads and missing media cannot pass.
export function pcmuTone(offset, frequency = 440) {
    const payload = Buffer.alloc(160);
    for (let i = 0; i < payload.length; i++) {
        let sample = Math.round(8000 * Math.sin(2 * Math.PI * frequency * (offset + i) / 8000));
        const sign = sample < 0 ? 0x80 : 0;
        sample = Math.min(Math.abs(sample), 32635) + 132;
        let exponent = 7;
        for (let mask = 0x4000; exponent > 0 && !(sample & mask); mask >>= 1) exponent--;
        payload[i] = ~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 15)) & 255;
    }
    return payload;
}

export function parseRtp(packet) {
    assert(packet.length >= 12 && packet[0] >> 6 === 2, 'invalid RTP header');
    let offset = 12 + (packet[0] & 15) * 4;
    if (packet[0] & 16) {
        assert(packet.length >= offset + 4, 'truncated RTP extension');
        offset += 4 + packet.readUInt16BE(offset + 2) * 4;
    }
    const end = packet.length - (packet[0] & 32 ? packet.at(-1) : 0);
    assert(offset < end, 'missing RTP payload');
    return {
        payloadType: packet[1] & 127,
        sequence: packet.readUInt16BE(2),
        timestamp: packet.readUInt32BE(4),
        payloadHex: packet.subarray(offset, end).toString('hex')
    };
}

export function assertAudio(packets, { minimum = 70, frequency = 440, label = 'audio' } = {}) {
    const audio = packets.filter(packet => packet.payloadType === 0);
    assert(audio.length >= minimum, `${label}: expected >=${minimum} PCMU packets, received ${audio.length}`);
    assert(new Set(audio.map(packet => packet.sequence)).size >= minimum, `${label}: repeated sequence numbers`);
    const samples = [];
    const audible = [];
    for (const packet of audio) {
        const payload = Buffer.from(packet.payloadHex, 'hex');
        assert.equal(payload.length, 160, `${label}: 20ms payload length`);
        const frame = [];
        for (const byte of payload) {
            const value = ~byte & 255;
            const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
            frame.push((value & 128 ? -1 : 1) * (magnitude - 132));
        }
        const energy = frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length;
        // Mixers insert silence when a sender arrives later than the 20ms clock.
        // Require sustained actual tone, excluding those clock-padding frames.
        if (Math.sqrt(energy) > 3000) { samples.push(...frame); audible.push(packet); }
    }
    assert(audible.length >= minimum, `${label}: expected >=${minimum} audible packets, received ${audible.length}`);
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    assert(rms > 4000 && rms < 7000, `${label}: decoded tone RMS ${rms}`);
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    const measured = crossings * 8000 / samples.length;
    assert(Math.abs(measured - frequency) < 25, `${label}: decoded frequency ${measured}, expected ${frequency}`);
    const elapsed = (audible.at(-1).timestamp - audible[0].timestamp) >>> 0;
    assert(elapsed >= (minimum - 1) * 160, `${label}: insufficient RTP duration`);
    for (let i = 1; i < audible.length; i++) {
        const gap = (audible[i].timestamp - audible[i - 1].timestamp) >>> 0;
        assert(gap <= 1600, `${label}: audio gap exceeds 200ms (${gap} ticks)`);
    }
    return { packets: audio.length, audible: audible.length, samples: samples.length, rms, frequency: measured };
}

export function pcapRtp(buffer, endpointId) {
    assert(buffer.length > 24, 'PCAP must contain packets');
    const littleEndian = buffer.readUInt32LE(0) === 0xa1b2c3d4;
    assert(littleEndian || buffer.readUInt32BE(0) === 0xa1b2c3d4, 'unsupported PCAP magic');
    const read32 = offset => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    assert.equal(read32(20), 1, 'expected Ethernet PCAP');
    const packets = [];
    let previousTime = 0;
    let descriptor;
    for (let offset = 24; offset < buffer.length;) {
        assert(offset + 16 <= buffer.length, 'truncated PCAP record header');
        const length = read32(offset + 8);
        assert.equal(read32(offset + 12), length, 'truncated capture');
        const time = read32(offset) * 1_000_000 + read32(offset + 4);
        assert(time >= previousTime, 'PCAP timestamps must be ordered');
        previousTime = time;
        offset += 16;
        assert(offset + length <= buffer.length, 'truncated PCAP packet');
        const frame = buffer.subarray(offset, offset + length);
        offset += length;
        // rtpbridge descriptor frames precede real IPv4/UDP/RTP frames.
        if (frame.length < 14 || frame.readUInt16BE(12) !== 0x0800) continue;
        assert(frame.length >= 42 && frame[23] === 17, 'expected IPv4 UDP recording');
        const udp = 14 + (frame[14] & 15) * 4;
        const udpLength = frame.readUInt16BE(udp + 4);
        assert.equal(udp + udpLength, frame.length, 'invalid UDP length');
        const payload = frame.subarray(udp + 8);
        if (payload.subarray(0, 4).toString() === 'RBP1') {
            descriptor = JSON.parse(payload.subarray(4).toString());
            assert.equal(descriptor.v, 1, 'recording descriptor version');
            assert.equal(descriptor.codec, 'PCMU', 'recording codec');
            assert.equal(descriptor.pt, 0, 'recording payload type');
            assert.equal(descriptor.clock_rate, 8000, 'recording clock rate');
            assert.equal(descriptor.channels, 1, 'recording channels');
            if (endpointId) assert.equal(descriptor.endpoint_id, endpointId, 'recording source endpoint');
            continue;
        }
        if (payload[1] >= 200 && payload[1] <= 204) continue;
        assert(descriptor, 'recording must describe its stream before media');
        const packet = parseRtp(payload);
        if (packet.payloadType === 0) packets.push(packet);
    }
    return packets;
}
