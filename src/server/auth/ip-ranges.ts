// Shared IP / CIDR matching for the auth seam (infra layer — NO domain imports). One home for the
// private-range knowledge that was inlined in trust-header.ts, now also feeding the IP-allowlist edge
// middleware and the forward-header trusted-proxy gate. Pure (no env) so it unit-tests directly; the
// env-configured extra ranges (TRUSTED_PRIVATE_RANGES, IP_ALLOWLIST, FORWARD_AUTH_TRUSTED_PROXIES) are
// merged by callers, never read here.
//
// Covers IPv4 + IPv6, including the IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) that proxies emit —
// reduced to its IPv4 value so a mapped loopback matches `127.0.0.0/8`.

/** A parsed IP as a fixed-width big-endian integer + its bit width (32 for v4, 128 for v6). */
interface ParsedIp {
  value: bigint;
  bits: 32 | 128;
}

/** Parse an IPv4 dotted-quad → 32-bit value, or null. */
function parseIpv4(ip: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** Parse an IPv6 literal (with `::` compression and optional IPv4 tail) → 128-bit value, or null. */
function parseIpv6(ip: string): bigint | null {
  if (!ip.includes(":")) return null;
  // Split off an embedded IPv4 tail (e.g. ::ffff:127.0.0.1) and turn it into two hextets.
  let head = ip;
  let tailGroups: string[] = [];
  const lastColon = ip.lastIndexOf(":");
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIpv4(maybeV4);
    if (v4 === null) return null;
    head = ip.slice(0, lastColon + 1);
    tailGroups = [((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16)];
    // head now ends with ':' — drop it so the split below is clean, unless head is just "::".
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }

  const doubleColon = head.split("::");
  if (doubleColon.length > 2) return null;
  const left = doubleColon[0] ? doubleColon[0].split(":") : [];
  const right = doubleColon.length === 2 && doubleColon[1] ? doubleColon[1].split(":") : [];
  const groups =
    doubleColon.length === 2
      ? [
          ...left,
          ...Array(8 - left.length - right.length - tailGroups.length).fill("0"),
          ...right,
          ...tailGroups,
        ]
      : [...left, ...tailGroups];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return value;
}

/** Parse an IP string (v4 or v6, incl. IPv4-mapped v6) into a comparable integer + width, or null. */
export function parseIp(ip: string): ParsedIp | null {
  const trimmed = ip.trim();
  const v4 = parseIpv4(trimmed);
  if (v4 !== null) return { value: v4, bits: 32 };
  const v6 = parseIpv6(trimmed);
  if (v6 === null) return null;
  // Reduce an IPv4-mapped address (::ffff:0:0/96) to plain IPv4 so it matches v4 CIDRs.
  if (v6 >> 32n === 0xffffn) return { value: v6 & 0xffffffffn, bits: 32 };
  return { value: v6, bits: 128 };
}

/** True if `ip` falls inside the `cidr` (e.g. "10.0.0.0/8", "fc00::/7", or a bare IP = /max). */
export function matchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const netStr = slash === -1 ? cidr : cidr.slice(0, slash);
  const net = parseIp(netStr);
  const addr = parseIp(ip);
  if (!net || !addr || net.bits !== addr.bits) return false;
  const prefix = slash === -1 ? net.bits : Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > net.bits) return false;
  if (prefix === 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(net.bits - prefix);
  return (net.value & mask) === (addr.value & mask);
}

/** True if `ip` matches ANY range in `ranges` (CIDR or bare IP). */
export function isInRanges(ip: string, ranges: readonly string[]): boolean {
  for (const r of ranges) {
    if (matchesCidr(ip, r)) return true;
  }
  return false;
}

// The built-in "trusted private" set: loopback, RFC1918, Tailscale/CGNAT (100.64.0.0/10 — the gap that
// prompted this), link-local, plus the IPv6 loopback / ULA / link-local. Docker's default bridges live
// in 172.16.0.0/12 (RFC1918) so they're already covered. Callers extend this via env, never mutate it.
export const DEFAULT_TRUSTED_RANGES: readonly string[] = [
  "127.0.0.0/8", // IPv4 loopback
  "10.0.0.0/8", // RFC1918
  "172.16.0.0/12", // RFC1918 (incl. Docker default bridges)
  "192.168.0.0/16", // RFC1918
  "100.64.0.0/10", // CGNAT — Tailscale
  "169.254.0.0/16", // IPv4 link-local
  "::1/128", // IPv6 loopback
  "fc00::/7", // IPv6 unique-local (ULA)
  "fe80::/10", // IPv6 link-local
];

/** True if `ip` is loopback / private / Tailscale / link-local per DEFAULT_TRUSTED_RANGES. */
export function isPrivateOrLoopback(ip: string): boolean {
  return isInRanges(ip, DEFAULT_TRUSTED_RANGES);
}
