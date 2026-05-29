// PNG character-card WRITER — the inverse of import/card.ts's `readPngTextChunk`. Manual chunk
// surgery (no PNG library, mirroring the reader): embed the card JSON as a base64 `ccv3` tEXt chunk,
// stripping any stale chara/ccv3 chunk first. PURE: (base PNG bytes, card JSON) → new PNG bytes.
import { Buffer } from "node:buffer";

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG CRC-32 (poly 0xedb88320), table built once. The reader ignores CRCs; a writer must compute them.
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(d: Uint8Array): boolean {
  return d.length >= 8 && PNG_SIGNATURE.every((b, i) => d[i] === b);
}

// One PNG chunk: length(4 BE) + type(4) + data + crc(4 BE over type+data).
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(Array.from(type, (ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

/**
 * Embed `cardJson` as a `ccv3` tEXt chunk in `basePng`, dropping any existing chara/ccv3 tEXt so the
 * card never carries two copies. The keyword is null-separated from the base64 value, exactly as
 * import/card.ts:readPngTextChunk expects. Throws if `basePng` isn't a PNG or has no IEND.
 */
export function embedCardChunk(basePng: Uint8Array, cardJson: unknown): Uint8Array {
  if (!isPng(basePng)) throw new Error("base image is not a PNG");
  const view = new DataView(basePng.buffer, basePng.byteOffset, basePng.byteLength);
  const decoder = new TextDecoder("utf-8");

  const kept: Uint8Array[] = [];
  let iend: Uint8Array | null = null;
  let offset = 8;
  while (offset + 8 <= basePng.length) {
    const length = view.getUint32(offset, false);
    if (offset + 12 + length > basePng.length) break; // truncated → stop
    const type = String.fromCharCode(...basePng.subarray(offset + 4, offset + 8));
    const whole = basePng.slice(offset, offset + 12 + length);
    offset += 12 + length;

    if (type === "tEXt") {
      const chunkData = whole.subarray(8, 8 + length);
      const nullIdx = chunkData.indexOf(0);
      const key = nullIdx >= 0 ? decoder.decode(chunkData.subarray(0, nullIdx)).toLowerCase() : "";
      if (key === "chara" || key === "ccv3") continue; // drop the stale card chunk
    }
    if (type === "IEND") iend = whole;
    else kept.push(whole);
  }
  if (!iend) throw new Error("PNG missing IEND chunk");

  // keyword "ccv3" \0 base64(json) — base64 is ASCII, so latin1 round-trips byte-for-byte.
  const b64 = Buffer.from(JSON.stringify(cardJson), "utf-8").toString("base64");
  const textData = new Uint8Array(Buffer.from(`ccv3\0${b64}`, "latin1"));
  const newChunk = makeChunk("tEXt", textData);

  const parts = [PNG_SIGNATURE, ...kept, newChunk, iend];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
