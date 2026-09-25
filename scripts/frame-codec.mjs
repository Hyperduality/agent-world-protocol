// Reference encoder/decoder for the AWP frame envelope (spec/transport/frames).
// Apache-2.0. Used by scripts/validate.mjs to exercise schemas/test-vectors/frames.json.

export const MAGIC = 0x46505741; // "AWPF" little-endian
export const VERSION = 1;
export const FLAG_KEYFRAME = 0x01;
export const FLAG_END_OF_BURST = 0x02;
export const FLAG_HAS_EXTENSIONS = 0x04;
export const FLAG_RESYNC = 0x08;
export const RESERVED_FLAG_MASK = 0xf0;

export const EXT_TICK = 0x01;
export const EXT_TS_SIM_NS = 0x02;
export const EXT_TS_SEND_NS = 0x03;
const REGISTERED_EXT_LEN = { [EXT_TICK]: 8, [EXT_TS_SIM_NS]: 8, [EXT_TS_SEND_NS]: 8 };

export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function u64ToNumber(big, field) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FrameError("AWP_INTEGER_RANGE", `${field} exceeds 2^53-1`);
  }
  return Number(big);
}

function i64ToNumber(big, field) {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (big > max || big < -max) {
    throw new FrameError("AWP_INTEGER_RANGE", `${field} exceeds ±(2^53-1)`);
  }
  return Number(big);
}

/**
 * Decode a frame. Returns { channel_id, seq, ts_mono_ns, flags, keyframe, end_of_burst, resync,
 * tick?, ts_sim_ns?, ts_send_ns?, vendor: [{type, value}], payload }.
 * Throws FrameError("AWP_MALFORMED" | "AWP_INTEGER_RANGE").
 */
export function decodeFrame(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 28) throw new FrameError("AWP_MALFORMED", "frame shorter than 28-byte header");
  if (dv.getUint32(0, true) !== MAGIC) throw new FrameError("AWP_MALFORMED", "bad magic");
  const version = dv.getUint8(4);
  if (version !== VERSION) throw new FrameError("AWP_MALFORMED", `unsupported version ${version}`);
  const flags = dv.getUint8(5);
  if (flags & FLAG_RESYNC && !(flags & FLAG_KEYFRAME)) throw new FrameError("AWP_MALFORMED", "resync without keyframe");
  const channel_id = dv.getUint16(6, true);
  const seq = u64ToNumber(dv.getBigUint64(8, true), "seq");
  const ts_mono_ns = u64ToNumber(dv.getBigUint64(16, true), "ts_mono_ns");
  const payload_len = dv.getUint32(24, true);

  const out = {
    channel_id,
    seq,
    ts_mono_ns,
    flags: flags & 0x0f, // reserved bits 4-7 are ignored (AWP-DAT-005)
    keyframe: (flags & FLAG_KEYFRAME) !== 0,
    end_of_burst: (flags & FLAG_END_OF_BURST) !== 0,
    resync: (flags & FLAG_RESYNC) !== 0,
    vendor: [],
  };

  let offset = 28;
  if (flags & FLAG_HAS_EXTENSIONS) {
    if (buf.length < 30) throw new FrameError("AWP_MALFORMED", "missing ext_len");
    const ext_len = dv.getUint16(28, true);
    offset = 30;
    const end = 30 + ext_len;
    if (end > buf.length) throw new FrameError("AWP_MALFORMED", "ext_len exceeds frame");
    const seen = new Set();
    while (offset < end) {
      if (offset + 2 > end) throw new FrameError("AWP_MALFORMED", "truncated TLV header");
      const type = dv.getUint8(offset);
      const len = dv.getUint8(offset + 1);
      if (offset + 2 + len > end) throw new FrameError("AWP_MALFORMED", "TLV value exceeds ext_len");
      if (seen.has(type)) throw new FrameError("AWP_MALFORMED", `duplicate extension type 0x${type.toString(16)}`);
      seen.add(type);
      if (type in REGISTERED_EXT_LEN && REGISTERED_EXT_LEN[type] !== len) {
        throw new FrameError("AWP_MALFORMED", `extension 0x${type.toString(16)} has len ${len}, expected ${REGISTERED_EXT_LEN[type]}`);
      }
      const valueOffset = offset + 2;
      if (type === EXT_TICK) {
        out.tick = u64ToNumber(dv.getBigUint64(valueOffset, true), "tick");
      } else if (type === EXT_TS_SIM_NS) {
        out.ts_sim_ns = i64ToNumber(dv.getBigInt64(valueOffset, true), "ts_sim_ns");
      } else if (type === EXT_TS_SEND_NS) {
        out.ts_send_ns = u64ToNumber(dv.getBigUint64(valueOffset, true), "ts_send_ns");
      } else if (type >= 0x80) {
        out.vendor.push({ type, value: Array.from(buf.subarray(valueOffset, valueOffset + len)) });
      }
      // reserved types (0x00, 0x04..0x7f) and unknown vendor types are skipped (AWP-DAT-006)
      offset = valueOffset + len;
    }
    offset = end;
  }

  if (offset + payload_len !== buf.length) {
    throw new FrameError("AWP_MALFORMED", `frame length ${buf.length} != ${offset} + payload_len ${payload_len}`);
  }
  out.payload = buf.subarray(offset, offset + payload_len);
  return out;
}

/**
 * Encode a frame from { channel_id, seq, ts_mono_ns, keyframe?, end_of_burst?, resync?, tick?, ts_sim_ns?, ts_send_ns?,
 * vendor?: [{type, value}], payload: Uint8Array, reservedBits?: number (test use only) }.
 */
export function encodeFrame(f) {
  const entries = [];
  if (f.tick !== undefined) entries.push({ type: EXT_TICK, value: u64Bytes(BigInt(f.tick)) });
  if (f.ts_sim_ns !== undefined) entries.push({ type: EXT_TS_SIM_NS, value: i64Bytes(BigInt(f.ts_sim_ns)) });
  if (f.ts_send_ns !== undefined) entries.push({ type: EXT_TS_SEND_NS, value: u64Bytes(BigInt(f.ts_send_ns)) });
  for (const v of f.vendor ?? []) entries.push({ type: v.type, value: Uint8Array.from(v.value) });
  const ext_len = entries.reduce((n, e) => n + 2 + e.value.length, 0);
  const hasExt = entries.length > 0;
  const payload = f.payload ?? new Uint8Array(0);
  const total = 28 + (hasExt ? 2 + ext_len : 0) + payload.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint8(4, VERSION);
  let flags = (f.keyframe ? FLAG_KEYFRAME : 0) | (f.end_of_burst ? FLAG_END_OF_BURST : 0) | (hasExt ? FLAG_HAS_EXTENSIONS : 0) | (f.resync ? FLAG_RESYNC : 0);
  flags |= (f.reservedBits ?? 0) & RESERVED_FLAG_MASK;
  dv.setUint8(5, flags);
  dv.setUint16(6, f.channel_id, true);
  dv.setBigUint64(8, BigInt(f.seq), true);
  dv.setBigUint64(16, BigInt(f.ts_mono_ns), true);
  dv.setUint32(24, payload.length, true);
  let offset = 28;
  if (hasExt) {
    dv.setUint16(28, ext_len, true);
    offset = 30;
    for (const e of entries) {
      buf[offset++] = e.type;
      buf[offset++] = e.value.length;
      buf.set(e.value, offset);
      offset += e.value.length;
    }
  }
  buf.set(payload, offset);
  return buf;
}

function u64Bytes(big) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, big, true);
  return b;
}
function i64Bytes(big) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, big, true);
  return b;
}

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (s) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g) ?? [], (h) => parseInt(h, 16));
