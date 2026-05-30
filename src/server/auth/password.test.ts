import { describe, expect, test } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "./password";

describe("password hashing", () => {
  test("round-trips a correct password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  });

  test("rejects a wrong password", async () => {
    const stored = await hashPassword("the right one");
    expect(await verifyPassword("the wrong one", stored)).toBe(false);
  });

  test("two hashes of the same password differ (per-user salt)", async () => {
    const a = await hashPassword("samepass123");
    const b = await hashPassword("samepass123");
    expect(a).not.toBe(b);
    expect(await verifyPassword("samepass123", a)).toBe(true);
    expect(await verifyPassword("samepass123", b)).toBe(true);
  });

  test("verify returns false (never throws) for null/empty/malformed stored values", async () => {
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", undefined)).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "not-the-format")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$salt$hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$only-two")).toBe(false);
  });

  test("rejects a too-short password at hash time", async () => {
    await expect(hashPassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow();
  });

  test("the constant-time DUMMY hash is well-formed but never verifies true", async () => {
    expect(DUMMY_PASSWORD_HASH.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword("anything at all", DUMMY_PASSWORD_HASH)).toBe(false);
  });

  test("rejects a stored hash whose digest isn't KEY_LEN bytes (no maxmem steering)", async () => {
    // 8-byte digest instead of 64 → rejected before scrypt runs.
    const shortHash = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(8).toString("base64")}`;
    expect(await verifyPassword("x", shortHash)).toBe(false);
  });
});
