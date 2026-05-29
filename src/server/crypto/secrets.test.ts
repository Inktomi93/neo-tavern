import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createSecretBox } from "./secrets";

describe("SecretBox — AES-256-GCM + AAD", () => {
  const box = createSecretBox(randomBytes(32));

  test("round-trips plaintext bound to its AAD; ciphertext doesn't leak it", () => {
    const sealed = box.encrypt("sk-or-secret-key", "user1|openrouter");
    expect(sealed.ciphertext).not.toContain("sk-or-secret-key");
    expect(box.decrypt(sealed, "user1|openrouter")).toBe("sk-or-secret-key");
  });

  test("a fresh IV per encryption — same plaintext seals differently", () => {
    const a = box.encrypt("same", "u|openrouter");
    const b = box.encrypt("same", "u|openrouter");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test("a wrong key fails to decrypt (GCM authentication)", () => {
    const sealed = box.encrypt("secret", "u|openrouter");
    const other = createSecretBox(randomBytes(32));
    expect(() => other.decrypt(sealed, "u|openrouter")).toThrow();
  });

  test("a mismatched AAD fails — a row can't be lifted into another user/provider slot", () => {
    const sealed = box.encrypt("secret", "user1|openrouter");
    expect(() => box.decrypt(sealed, "user2|openrouter")).toThrow();
  });

  test("a disabled box (no key) reports off and refuses to encrypt", () => {
    const off = createSecretBox(null);
    expect(off.enabled).toBe(false);
    expect(() => off.encrypt("x", "u|openrouter")).toThrow();
  });
});
