/* This file reads and writes cross-save .tamasave files. The C codec uses the
   same wire format, and the shared fixture test keeps both copies in sync */

const enc = new TextEncoder();
const dec = new TextDecoder();
const STAT_HEADER = 52;
const WEB_RUNTIME = 'tamaemu-web';
const WEB_VERSION = 1;

const u8 = x => x instanceof Uint8Array ? x : new Uint8Array(x);

function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) {
        c ^= b;
        for (let i = 0; i < 8; i++)
            c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
}

function put32(a, o, v) {
    new DataView(a.buffer, a.byteOffset, a.byteLength).setUint32(o, v, true);
}

function put64(a, o, v) {
    new DataView(a.buffer, a.byteOffset, a.byteLength).setBigUint64(o, BigInt(v), true);
}

function record(type, payload) {
    const p = u8(payload);
    const out = new Uint8Array(12 + p.length);
    out.set(enc.encode(type), 0);
    put32(out, 4, p.length);
    put32(out, 8, crc32(p));
    out.set(p, 12);
    return out;
}

function readTag(bytes, offset, length) {
    let end = 0;
    while (end < length && bytes[offset + end]) end++;
    if (!end || end === length) return null;
    for (let i = 0; i < end; i++) {
        if (bytes[offset + i] < 0x20 || bytes[offset + i] > 0x7e)
            return null;
    }
    return dec.decode(bytes.subarray(offset, offset + end));
}

function writeTag(bytes, offset, length, tag) {
    const value = enc.encode(tag ?? '');
    if (!value.length || value.length >= length)
        throw new Error('invalid snapshot tag');
    bytes.set(value, offset);
}

function statPayload(s) {
    const session = u8(s.session);
    const out = new Uint8Array(STAT_HEADER + session.length);

    /* The container puts runtime, build, and snapshot-version tags before the
       private snapshot. The C decoder checks them before it accepts a STAT. */
    writeTag(out, 0, 16, s.stateRuntime ?? WEB_RUNTIME);
    writeTag(out, 16, 32, s.stateBuild ?? WEB_RUNTIME);
    put32(out, 48, s.stateVersion ?? WEB_VERSION);
    out.set(session, STAT_HEADER);
    return out;
}

export function encodeTamaSave(s) {
    if (!s?.device || !s.flash?.length || !s.ram?.length || !s.lineage || s.lineage.length !== 16)
        throw new Error('missing required save record');

    const meta = new Uint8Array(32);
    meta.set(s.lineage);
    put64(meta, 16, s.revision ?? 0);
    put64(meta, 24, s.savedUtcMs ?? 0);

    const records = [
        record('META', meta),
        record('DEV ', enc.encode(s.device)),
        record('SAV ', s.flash),
        record('RAM ', s.ram),
    ];
    if (s.session?.length) records.push(record('STAT', statPayload(s)));

    const totalLength = 16 + records.reduce((n, r) => n + r.length, 0);
    const out = new Uint8Array(totalLength);
    out.set(enc.encode('TAMASAVE'), 0);
    put32(out, 8, 1);
    put32(out, 12, records.length);

    let offset = 16;
    for (const current of records) {
        out.set(current, offset);
        offset += current.length;
    }
    return out;
}

export function decodeTamaSave(bytes) {
    const b = u8(bytes);
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length < 16 || dec.decode(b.subarray(0, 8)) !== 'TAMASAVE' ||
        d.getUint32(8, true) !== 1)
        throw new Error('bad .tamasave header');

    let offset = 16;
    let meta;
    let device;
    let flash;
    let ram;
    let session = new Uint8Array();
    let stateRuntime = '';
    let stateBuild = '';
    let stateVersion = 0;
    let stateWarning = '';
    const seen = new Set();
    const recordCount = d.getUint32(12, true);

    for (let i = 0; i < recordCount; i++) {
        if (offset + 12 > b.length) throw new Error('truncated record');

        const type = dec.decode(b.subarray(offset, offset + 4));
        const length = d.getUint32(offset + 4, true);
        if (offset + 12 + length > b.length) throw new Error('truncated record');

        const payload = b.slice(offset + 12, offset + 12 + length);
        const crcOk = crc32(payload) === d.getUint32(offset + 8, true);
        if (!crcOk && type !== 'STAT') throw new Error('invalid record');
        if (type !== 'STAT' && seen.has(type)) throw new Error('invalid record');

        if (type === 'STAT') {
            if (seen.has(type) || !crcOk || length <= STAT_HEADER) {
                stateWarning = 'snapshot ignored';
            } else {
                seen.add(type);
                const runtime = readTag(payload, 0, 16);
                const build = readTag(payload, 16, 32);
                if (!runtime || !build) {
                    stateWarning = 'snapshot ignored';
                } else {
                    stateRuntime = runtime;
                    stateBuild = build;
                    stateVersion = new DataView(payload.buffer, payload.byteOffset,
                                                payload.byteLength).getUint32(48, true);
                    if (runtime === WEB_RUNTIME && stateVersion === WEB_VERSION) {
                        session = payload.slice(STAT_HEADER);
                    } else {
                        stateWarning = 'snapshot is for another runtime';
                    }
                }
            }
        } else {
            seen.add(type);
            if (type === 'META') {
                meta = payload;
            } else if (type === 'DEV ') {
                device = dec.decode(payload);
            } else if (type === 'SAV ') {
                flash = payload;
            } else if (type === 'RAM ') {
                ram = payload;
            }
        }
        offset += 12 + length;
    }

    if (offset !== b.length || !meta || meta.length !== 32 || !device ||
        !flash?.length || !ram?.length)
        throw new Error('missing required record');

    const metadata = new DataView(meta.buffer, meta.byteOffset, 32);
    return {
        lineage: meta.slice(0, 16),
        revision: metadata.getBigUint64(16, true),
        savedUtcMs: metadata.getBigUint64(24, true),
        device,
        flash,
        ram,
        session,
        stateRuntime,
        stateBuild,
        stateVersion,
        stateWarning,
    };
}
