import { customType } from "drizzle-orm/sqlite-core";

// libSQL NATIVE vector column. Stored as the raw little-endian Float32 blob (which IS
// libSQL's F32_BLOB on-wire format) — this avoids the drizzle `sql\`vector32()\`` insert
// caveat (#3899). The query vector is wrapped with vector32(?) in the search SQL.
export const vector32 = customType<{
  data: Float32Array;
  driverData: Uint8Array;
  config: { dim: number };
}>({
  dataType(config) {
    return `F32_BLOB(${config?.dim ?? 1024})`;
  },
  toDriver(value: Float32Array): Uint8Array {
    const buffer = new ArrayBuffer(value.length * 4);
    const view = new DataView(buffer);
    for (let i = 0; i < value.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by length
      view.setFloat32(i * 4, value[i]!, true);
    }
    return new Uint8Array(buffer);
  },
  fromDriver(value: Uint8Array): Float32Array {
    // Copy into a fresh, 4-byte-aligned buffer (the driver may hand back an
    // unaligned subarray view, which Float32Array can't wrap directly).
    const bytes = Uint8Array.from(value);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  },
});
