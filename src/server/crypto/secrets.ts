import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env";

// AES-256-GCM encryption-at-rest for per-user secrets (docs/auth/auth-and-credentials-plan.md §7) — an
// upgrade over SillyTavern's plaintext secrets.json. Exposed as an injectable SecretBox (the project's
// DI idiom) so the store/resolver receive it and tests can supply a known key; the composition root
// builds the env-backed one. Key = base64-decoded CREDENTIALS_KEY (32 bytes); UNSET/invalid ⇒ a
// DISABLED box (encrypt/decrypt throw; the store rejects writes, the resolver falls back to the host
// key) — degrade, NEVER throw at boot (§15). Fresh 12-byte IV per encryption (never reuse with a key).
// AAD binds a ciphertext to `${userId}|${provider}` so a row can't be lifted into another user's /
// provider's slot and still decrypt. Key rotation (re-encrypt-all) is a future op, not handled here.

export interface Sealed {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  tag: string; // base64 (GCM auth tag)
}

export interface SecretBox {
  /** false when no valid CREDENTIALS_KEY is configured → per-user credential storage is off. */
  readonly enabled: boolean;
  /** Seal plaintext, bound to `aad`. Throws if the box is disabled. */
  encrypt(plaintext: string, aad: string): Sealed;
  /** Open a sealed value, verifying `aad`. Throws if disabled, or if the key/AAD/tag don't match. */
  decrypt(sealed: Sealed, aad: string): string;
}

export function createSecretBox(key: Buffer | null): SecretBox {
  return {
    enabled: key !== null,
    encrypt(plaintext: string, aad: string): Sealed {
      if (!key) {
        throw new Error("CREDENTIALS_KEY is not set; per-user credential encryption is disabled.");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    },
    decrypt(sealed: Sealed, aad: string): string {
      if (!key) {
        throw new Error("CREDENTIALS_KEY is not set; cannot decrypt a per-user credential.");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      // final() throws if the tag/AAD/key don't verify — a wrong key or a lifted row fails loudly.
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

// Decode + validate the env key once. Returns null (⇒ a disabled box) for unset/malformed/wrong-length
// — so a missing or bad key degrades gracefully rather than crashing the server at boot.
export function credentialsKeyFromEnv(): Buffer | null {
  const raw = env.CREDENTIALS_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}
