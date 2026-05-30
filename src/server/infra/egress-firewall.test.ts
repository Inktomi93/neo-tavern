import { describe, expect, test } from "vitest";
import { shouldBlockEgress } from "./egress-firewall";

const NONE: ReadonlySet<string> = new Set();

describe("shouldBlockEgress", () => {
  test("blocks private / loopback / link-local / Tailscale resolved addresses", () => {
    expect(shouldBlockEgress("127.0.0.1", "evil.example", NONE)).toBe(true);
    expect(shouldBlockEgress("10.0.0.5", "evil.example", NONE)).toBe(true);
    expect(shouldBlockEgress("192.168.1.1", "evil.example", NONE)).toBe(true);
    expect(shouldBlockEgress("169.254.169.254", "metadata", NONE)).toBe(true); // cloud metadata IP
    expect(shouldBlockEgress("100.100.0.1", "ts", NONE)).toBe(true); // Tailscale CGNAT
    expect(shouldBlockEgress("::1", "evil.example", NONE)).toBe(true);
  });

  test("allows public addresses (openrouter / HF CDN resolve here)", () => {
    expect(shouldBlockEgress("8.8.8.8", "openrouter.ai", NONE)).toBe(false);
    expect(shouldBlockEgress("2606:4700::1111", "cdn.example", NONE)).toBe(false);
  });

  test("allowlisted hostname may resolve to a private IP (LAN OIDC issuer)", () => {
    const allow = new Set(["auth.lan"]);
    expect(shouldBlockEgress("10.0.0.9", "auth.lan", allow)).toBe(false);
    expect(shouldBlockEgress("10.0.0.9", "AUTH.LAN", allow)).toBe(false); // case-insensitive
    expect(shouldBlockEgress("10.0.0.9", "other.lan", allow)).toBe(true); // not allowlisted
  });
});
