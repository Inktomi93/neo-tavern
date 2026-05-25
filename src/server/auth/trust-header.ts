// The auth seam. Authentik terminates auth and caddy forwards X-Authentik-Username
// — but a header is only as trustworthy as the hop that set it, so we believe it
// ONLY when the request also carries the shared X-Neo-Proxy secret (which caddy
// injects and strips from client copies). Any request without it (direct LAN/IP
// access — used often) resolves to the owner. No sessions, no CSRF; identity is
// resolved per-request from headers. See CLAUDE.md "Auth & tenancy".
const PROXY_HEADER = "x-neo-proxy";
const USER_HEADER = "x-authentik-username";

export function resolveUsername(
  headers: Headers,
  proxySecret: string | undefined,
  defaultHandle: string,
): string {
  if (proxySecret && headers.get(PROXY_HEADER) === proxySecret) {
    const user = headers.get(USER_HEADER);
    if (user) {
      return user;
    }
  }
  return defaultHandle;
}
