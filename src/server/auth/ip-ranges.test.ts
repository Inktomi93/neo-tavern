import { describe, expect, test } from "vitest";
import { isInRanges, isPrivateOrLoopback, matchesCidr, parseIp } from "./ip-ranges";

describe("matchesCidr", () => {
  test("IPv4 inside / outside a /8", () => {
    expect(matchesCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(matchesCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });

  test("a bare IP is an exact (/32, /128) match", () => {
    expect(matchesCidr("192.168.1.5", "192.168.1.5")).toBe(true);
    expect(matchesCidr("192.168.1.6", "192.168.1.5")).toBe(false);
  });

  test("IPv6 ULA prefix", () => {
    expect(matchesCidr("fd12:3456::1", "fc00::/7")).toBe(true);
    expect(matchesCidr("2001:db8::1", "fc00::/7")).toBe(false);
  });

  test("v4 and v6 never cross-match", () => {
    expect(matchesCidr("::1", "127.0.0.0/8")).toBe(false);
    expect(matchesCidr("127.0.0.1", "::1/128")).toBe(false);
  });

  test("a malformed prefix is rejected", () => {
    expect(matchesCidr("10.0.0.1", "10.0.0.0/99")).toBe(false);
    expect(matchesCidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
  });
});

describe("isPrivateOrLoopback (incl. Tailscale CGNAT)", () => {
  test.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.9.9",
    "192.168.1.1",
    "100.100.50.50", // Tailscale CGNAT 100.64.0.0/10 — the gap that prompted this
    "169.254.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
  ])("%s is trusted", (ip) => {
    expect(isPrivateOrLoopback(ip)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "100.200.0.1", // 100.200 is OUTSIDE 100.64.0.0/10 (public)
    "2001:db8::1",
  ])("%s is NOT trusted", (ip) => {
    expect(isPrivateOrLoopback(ip)).toBe(false);
  });
});

describe("parseIp — IPv4-mapped IPv6", () => {
  test("::ffff:127.0.0.1 reduces to the IPv4 loopback", () => {
    expect(isPrivateOrLoopback("::ffff:127.0.0.1")).toBe(true);
    const mapped = parseIp("::ffff:127.0.0.1");
    expect(mapped?.bits).toBe(32);
  });

  test("garbage parses to null", () => {
    expect(parseIp("not-an-ip")).toBeNull();
    expect(parseIp("999.1.1.1")).toBeNull();
  });
});

describe("isInRanges", () => {
  test("matches any entry; empty list matches nothing", () => {
    expect(isInRanges("10.0.0.1", ["192.168.0.0/16", "10.0.0.0/8"])).toBe(true);
    expect(isInRanges("10.0.0.1", [])).toBe(false);
  });
});
