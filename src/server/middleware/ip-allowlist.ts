import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { isInRanges } from "../auth/ip-ranges";
import { getLog } from "../observability/logger";

// Optional IP/CIDR allowlist EDGE belt (env IP_ALLOWLIST) — orthogonal to AUTH_MODE, off by default.
// A blunt network gate in front of everything: when configured, a request whose client IP is outside
// the allowlist (and outside loopback) gets a 403 before auth runs. Complements any mode (e.g. lock a
// single-user or local box to your LAN / Tailscale range). Loopback is ALWAYS allowed so you can never
// lock yourself out of the host (the Marinara/ST rule).
//
// Client IP precedence: the leftmost X-Forwarded-For hop (Caddy sets it to the real client), then
// X-Real-IP, then the raw socket peer (direct, un-proxied dev). Behind Caddy this is the real client;
// the deployment invariant (don't expose :8788) keeps XFF trustworthy.

// Loopback is unconditionally allowed — a self-lockout backstop independent of the operator's list.
const LOOPBACK: readonly string[] = ["127.0.0.0/8", "::1/128"];

function clientIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  // Direct (un-proxied) connection — the socket peer.
  const addr = getConnInfo(c).remote.address;
  return addr ?? null;
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
    getLog().warn({ ip, path: c.req.path }, "security: request blocked by IP_ALLOWLIST");
    return c.json({ error: "Forbidden." }, 403);
  };
}
