import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { isInRanges, isPrivateOrLoopback } from "../auth/ip-ranges";
import { securityEvent } from "../observability/logger";

// Optional IP/CIDR allowlist EDGE belt (env IP_ALLOWLIST) — orthogonal to AUTH_MODE, off by default.
// A blunt network gate in front of everything: when configured, a request whose client IP is outside
// the allowlist (and outside loopback) gets a 403 before auth runs. Complements any mode (e.g. lock a
// single-user or local box to your LAN / Tailscale range). Loopback is ALWAYS allowed so you can never
// lock yourself out of the host (the Marinara/ST rule).
//
// Client IP precedence (trusted-proxy aware): start from the SOCKET PEER (un-spoofable). Only when the
// peer is itself a private/loopback proxy (i.e. Caddy on the same host/network) do we honor the
// leftmost X-Forwarded-For / X-Real-IP it set. If the peer is a PUBLIC address — meaning the request
// reached us directly — we IGNORE XFF and gate on the real peer, so a client can't prepend a trusted IP
// to `X-Forwarded-For` and walk through the allowlist. This makes the belt meaningful even un-proxied.

// Loopback is unconditionally allowed — a self-lockout backstop independent of the operator's list.
const LOOPBACK: readonly string[] = ["127.0.0.0/8", "::1/128"];

/** The raw socket peer address, or null if unavailable (getConnInfo throws when there's no node-server
 *  connection context — e.g. a non-node runtime or an in-process test request). Fail safe → null. */
function peerAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

function clientIp(c: Context): string | null {
  const peer = peerAddress(c);
  // Direct connection from a public peer → that peer IS the client; forwarded headers are untrusted.
  if (peer && !isPrivateOrLoopback(peer)) return peer;
  // Peer is a local/private proxy (or unknown) → trust the proxy-set forwarded client IP.
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  return peer;
}

/** Build the allowlist middleware for the given CIDR list. (Callers only mount it when the list is
 *  non-empty; an empty list here would 403 everything but loopback, which is never what we want.) */
export function ipAllowlistMiddleware(allowlist: readonly string[]): MiddlewareHandler {
  const allowed = [...LOOPBACK, ...allowlist];
  return async (c, next) => {
    const ip = clientIp(c);
    if (ip && isInRanges(ip, allowed)) {
      return next();
    }
    securityEvent("ip_allowlist_blocked", { ip, path: c.req.path });
    return c.json({ error: "Forbidden." }, 403);
  };
}
