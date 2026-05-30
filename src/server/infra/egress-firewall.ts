import { lookup as dnsLookup } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";
import { isPrivateOrLoopback } from "../auth/ip-ranges";
import { env } from "../env";
import { getLog } from "../observability/logger";

// SSRF egress firewall (breadth-buildout A.2.1). The app's outbound HTTP (OpenRouter, the HF model CDN,
// OIDC discovery, and — the one user-influenced vector — the X-Authentik-Meta-Jwks URL) all go through
// Node's global fetch/undici. ST's `private-request-filter.js` swaps `http.globalAgent`, but Node 24's
// fetch/undici IGNORE that — the correct seam is `undici.setGlobalDispatcher(new Agent({ connect:
// { lookup } }))`. Our custom lookup resolves DNS itself and REJECTS private/loopback/link-local/
// Tailscale addresses, then passes the RESOLVED address straight to connect — closing the DNS-rebinding
// TOCTOU (the name can't re-resolve to a different IP between check and connect).
//
// Public targets (openrouter.ai, the HF CDN) resolve to public IPs → allowed. Internal hosts an
// operator legitimately needs (a LAN OIDC issuer / JWKS host) go in EGRESS_ALLOWLIST by hostname.
//
// This is primarily defense-in-depth: the only current user-influenced URL (the JWKS URL) is already
// https+host-allowlisted at the auth seam (A.2.6). It pays off the moment a feature adds any
// user-supplied outbound URL (avatar-by-URL, webhooks, …).

/** The pure block decision: a resolved private/loopback address is blocked UNLESS its hostname is on
 *  the allowlist (case-insensitive). Public addresses are always allowed. Exported for unit testing. */
export function shouldBlockEgress(
  address: string,
  hostname: string,
  allowlist: ReadonlySet<string>,
): boolean {
  if (!isPrivateOrLoopback(address)) return false;
  return !allowlist.has(hostname.toLowerCase());
}

/** Install the global undici dispatcher with a private-IP-rejecting DNS lookup. No-op when disabled. */
export function installEgressFirewall(): void {
  if (!env.EGRESS_FIREWALL) return;
  const allowlist = new Set(
    (env.EGRESS_ALLOWLIST ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
  // Always allow the OIDC issuer host (discovery + token + JWKS) even on a LAN/private IP — otherwise
  // enabling the firewall would break oidc mode against a homelab-hosted authentik. Operators add other
  // internal hosts via EGRESS_ALLOWLIST.
  if (env.OIDC_ISSUER) {
    try {
      allowlist.add(new URL(env.OIDC_ISSUER).hostname.toLowerCase());
    } catch {
      /* malformed issuer — env refinement would have caught it in oidc mode */
    }
  }

  setGlobalDispatcher(
    new Agent({
      connect: {
        lookup(hostname, options, callback) {
          dnsLookup(hostname, options, (err, address, family) => {
            if (err) {
              callback(err, address as string, family as number);
              return;
            }
            const addr = String(address);
            if (shouldBlockEgress(addr, hostname, allowlist)) {
              getLog().warn(
                { hostname, address: addr },
                "security: egress SSRF blocked (private address)",
              );
              callback(new Error(`SSRF_BLOCKED: ${hostname} → ${addr}`), address as string, family);
              return;
            }
            // Hand the resolved address straight through — no second resolution (rebinding-safe).
            callback(null, address as string, family);
          });
        },
      },
    }),
  );
  getLog().info(
    { allowlist: [...allowlist] },
    "security: egress firewall installed (private egress blocked)",
  );
}
