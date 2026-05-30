# Plan: pluggable auth (single-user / forward-header / OIDC) + user & per-user-credential foundation

> **STATUS: BUILT** (migrations 0025–0026 + the `feat(auth)` commits — see the git log). This doc
> remains the **design rationale** (the *why*); `docs/auth/auth-deploy.md` is the deploy recipe. The server/domain/
> API are implemented + green; the **frontend** (login UI, key-entry, user-admin screens) is the
> remaining piece. Implementation notes vs the original plan: `resolveUsername` is async (the
> resolution does I/O); CSRF gates per-request on `viaCookie` (not on `AUTH_MODE`); admin-gating is
> narrow (AppSettings + `userAdmin` only — the OpenRouter account endpoints are `authedProcedure`, per-
> user; the only credential gate is `max-pro-sub` via the turn-time resolver); the host
> `OPENROUTER_API_KEY` is a temporary fallback (per-user keys are the goal).

---

## §0. Context — why, and the exact outcome

Three coupled gaps pushed us here as we move from *implemented*-single-user toward *real* multi-user:

1. **The header-trust model can't authenticate the path the owner actually uses.** Identity today =
   `X-Authentik-Username`, trusted only behind caddy+authentik forward-auth; **direct LAN/IP access
   falls back to `DEFAULT_USER_HANDLE` = owner — so on the LAN every visitor is the owner.** A "work
   account vs personal account" distinction therefore only exists when traffic goes through the proxy.
2. **No per-user credentials.** `max-pro-sub` is the owner's single host `claude login` — free, but
   it is the owner's *personal allowance and Anthropic identity*. A non-owner must never spend it.
   The usable answer is **bring-your-own OpenRouter key** (which lights up the agent-sdk OpenRouter
   skin = mode 2, chat-completions = mode 3, and responses = mode 4 — i.e. everything except the
   owner-only sub). No per-user secret store exists today.
3. **Auth must be OPTIONAL.** Not every deployment has an SSO homelab. The app must run with **zero
   auth infrastructure** out of the box, with forward-auth and OIDC as opt-in upgrades.

**Outcome to build:** auth becomes a **pluggable mode**; a user layer + an **encrypted per-user
credential store** sit on top, identity-source-agnostic; a single **credential resolver** is the one
place that decides "can this user use this credential" at turn time. A second account can BYO an
OpenRouter key and generate on its own dime, on any access path, without touching the owner's sub.

### Decisions locked with the owner (do not re-litigate; implement)
- **Auth is LAYERED, not a single rigid mode (§2):** `AUTH_MODE` picks the SSO mechanism
  (`single-user` DEFAULT · `forward-header` · `oidc`) and `AUTH_FALLBACK` (`owner`|`deny`) decides the
  un-credentialed case. The resolver tries cookie → forward-auth header → fallback per request, so
  **`oidc` + `AUTH_FALLBACK=owner` = SSO on the domain AND owner on the raw LAN IP, simultaneously,
  from one process.** (`deny` = SSO mandatory.)
- **OIDC sessions are BEARER TOKENS, never cookies** — and **server-side / revocable** (an opaque
  session id backed by a `sessions` row, §4), carried in an **HttpOnly, Secure, SameSite=Lax
  cookie** — the **BFF pattern, which we already are** (confidential OIDC client, server-side). This
  is what OWASP + the IETF *OAuth 2.0 for Browser-Based Apps* BCP recommend; **NOT** a localStorage
  bearer (any single XSS would steal it — HttpOnly means an XSS can't exfiltrate the credential).
  CSRF is then mitigated *cheaply and invisibly*: `SameSite=Lax` (blocks cross-site POST) + a required
  **custom request header** on mutations + server-side PKCE state — no heavy CSRF middleware, no
  user-visible "dance". Server-side sessions = logout/disable/kick-a-device take effect *immediately*.
  (Authenticated modes are HTTPS-only; the raw-`http://LAN-IP` path is `single-user`, which has no
  session/cookie at all — §5a.) (See §4, §11.)
- **Auth ⟂ push.** Multi-device live sync (the SSE/subscription, keyed by chatId, scoped to identity)
  is independent of how identity is established. SSO does NOT disable push. (See §5.)
- **Per-user secrets encrypted at rest** (AES-256-GCM, key from env `CREDENTIALS_KEY`). This is an
  *upgrade over SillyTavern*, which stores per-user secrets **plaintext** in `secrets.json`.
- **`max-pro-sub` = host credential, owner/admin-only.** `OWNER_HANDLES`/`OWNER_GROUP` → those
  identities provision as `role:'admin'`. There is no per-user Claude-sub variant.
- **One credential resolver is the turn-time chokepoint** and the correct (and only) home for the
  access guard — `resolveTurnRouting` is pure/sync and cannot do it.

---

## §0.5. Build order — proper reusable seams, not ad-hoc (do it right the first time)

**Read first (orient before writing a line):** `src/server/auth/trust-header.ts` (the seam) ·
`src/server/trpc/trpc.ts` (the procedure/middleware pattern) + `trpc/context.ts` + `trpc/routers/*` ·
`src/server/app.ts` (`createContext` + the Hono routes + every `resolveUsername` call site) ·
`src/server/env.ts` · `_shared/users.ts` (`ensureUser`) + `_shared/admin.ts` (`requireAdmin`, already
built) · the chat verbs `domain/chat/{send,swipe,compaction,lifecycle}.ts` + the two host-OR-key sites
`providers/openrouter/client.ts` & `providers/claude-sdk/config.ts` · the migration flow
(`pnpm db:generate:force`). The plan points to all of these inline; confirm them, don't assume.

**Build these as real, reusable systems — IN THIS ORDER — each its own green `pnpm check` commit:**
1. **Schema in ONE migration** (§13): `users.externalId`/`enabled` + `sessions` + `user_credentials`.
   Generate once; build code on it. No dribbled follow-up migrations.
2. **env** (§12): all new vars + the `AUTH_MODE=oidc ⇒ OIDC vars required` refinement, up front.
3. **The auth resolver seam** (§2): `resolveIdentity` (layered: cookie → forward-header → fallback) +
   the `resolveUsername` string wrapper + `provisionIdentity`. The ONE identity source; everything
   consumes it.
4. **The tRPC procedure ladder** (canonical — build ONCE, every router uses it; no scattered per-route
   auth): `publicProcedure` (exists) → **`authedProcedure`** (resolved identity required + the CSRF
   mutation-header check, §4/§2) → **`adminProcedure`** (`requireAdmin`). Retrofit existing routers onto
   it where they should be gated.
5. **The sessions domain** (§4): a real service — `create / validateByHash / revoke / revokeAllForUser /
   slideExpiry`. Reused by OIDC, the `userAdmin` revoke, and any future API token. Cookie I/O via Hono's
   `getCookie`/`setCookie`.
6. **`crypto/secrets` + the credential resolver** (§7/§8): the resolver is the SINGLE turn-time
   credential chokepoint — build it, THEN wire the turn path (§9). Never scatter key reads.
7. **OIDC routes** (§10) LAST, on top of 3–6.

The point: 4 (the procedure ladder), 5 (sessions), 6 (the resolver) are *systems other code hangs off* —
build them as clean seams now so nothing has to be migrated/re-plumbed later.

---

## §1. Authentik integration reference — GROUND TRUTH from the owner's live stack

Read from the deployed `inktomi-stack/docker-compose.yaml` and `inktomi-stack/caddy/conf/Caddyfile`
(not doc guesses). authentik image `ghcr.io/goauthentik/server:2025.12.4`, host
`authentik.inktomi.tech`, outpost container `authentik-server:9000`. The owner already runs THREE
OIDC-client apps against it (Open WebUI, Grafana, Forgejo) and forward-auth on several others — so
both SSO modes have a working in-stack reference. **Use OIDC discovery at runtime regardless; the
URLs below are the confirmed shape.**

### 1a. OIDC provider (for `AUTH_MODE=oidc`) — confirmed from Open WebUI + Grafana config
- **Discovery:** `https://authentik.inktomi.tech/application/o/<app-slug>/.well-known/openid-configuration`
  (Open WebUI's slug is `open-webui`; ours would be e.g. `neo-tavern`).
- **Authorize:** `https://authentik.inktomi.tech/application/o/authorize/`
- **Token:** `https://authentik.inktomi.tech/application/o/token/`
- **Userinfo:** `https://authentik.inktomi.tech/application/o/userinfo/`
- **End-session (RP logout):** `https://authentik.inktomi.tech/application/o/<slug>/end-session/`
- **JWKS:** `https://authentik.inktomi.tech/application/o/<slug>/jwks/`
- **Flow:** Authorization Code + **PKCE** (S256), with `state` + `nonce`. **Confidential client** —
  the other apps use a client-id + client-secret pair (e.g. `OPENWEBUI_OAUTH_CLIENT_ID/SECRET`,
  `GRAFANA_OAUTH_CLIENT_ID/SECRET`). Ours: `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET`.
- **Redirect URIs:** authentik allows **multiple** entries (and regex/wildcard). Register **every
  origin** you'll log in from — `https://neo-tavern.inktomi.tech/api/auth/callback` AND the LAN
  callback(s) — so OIDC works via the domain *and* the LAN IP/host (§10 picks the matching one per
  request). **Use an explicit strict list, not a loose regex** — per **CVE-2024-52289** authentik does
  not auto-escape `.` in regex mode, so a careless pattern becomes an open redirect.
- **Scopes:** `openid profile email` (Grafana's exact set; Open WebUI adds `offline_access` for
  refresh — we do NOT in v1, §11).
- **Claims (authentik defaults — our identity mapping):** `sub` = **stable UUID** (our externalId,
  immutable across renames) · `preferred_username` = username (our display handle) · `email` ·
  `name` · `groups` = array of group names.
- **Groups → roles is already the house pattern.** Grafana maps roles off the `groups` claim
  (`contains(groups,'Grafana Admins') && 'Admin'…`). So our admin/owner determination mirrors it: an
  authentik group (e.g. `Neo Owners`) → `role:'admin'`. See §6 — support BOTH a group and
  `OWNER_HANDLES`, group preferred since it matches the owner's existing convention.

### 1b. Forward-auth headers (for `AUTH_MODE=forward-header`) — VERBATIM from the live Caddyfile
The reusable `(authentik)` snippet proxies `/outpost.goauthentik.io/*` → `authentik-server:9000` and
`forward_auth`s to `…/auth/caddy`, copying these headers upstream (exact list):
```
X-Authentik-Username  X-Authentik-Groups  X-Authentik-Entitlements  X-Authentik-Email
X-Authentik-Name  X-Authentik-Uid  X-Authentik-Jwt  X-Authentik-Meta-Jwks
X-Authentik-Meta-Outpost  X-Authentik-Meta-Provider  X-Authentik-Meta-App  X-Authentik-Meta-Version
```
The verbatim snippet (for `docs/auth/auth-deploy.md`):
```caddyfile
(authentik) {
	reverse_proxy /outpost.goauthentik.io/* http://authentik-server:9000 {
		header_down -Clear-Site-Data
	}
	forward_auth http://authentik-server:9000 {
		uri /outpost.goauthentik.io/auth/caddy
		copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Entitlements X-Authentik-Email X-Authentik-Name X-Authentik-Uid X-Authentik-Jwt X-Authentik-Meta-Jwks X-Authentik-Meta-Outpost X-Authentik-Meta-Provider X-Authentik-Meta-App X-Authentik-Meta-Version
		trusted_proxies private_ranges
	}
}
```
- **Identity mapping (same as OIDC, so §6 is mode-agnostic):** externalId = `X-Authentik-Uid` (=`sub`);
  handle = `X-Authentik-Username` (=`preferred_username`); `X-Authentik-Email`, `X-Authentik-Groups`
  also available. (The owner's two real identities, from the ST block: personal `inktomi93@gmail.com`
  and work `nate.berg@one-line.com` — the concrete OWNER set + the multi-account test case.)
- **`X-Authentik-Jwt` IS forwarded, and so is `X-Authentik-Meta-Jwks`** (the JWKS to verify it) → §1c.

### 1c. TRUST MODEL — reconciled with reality (supersedes the CLAUDE.md `X-Neo-Proxy` claim)
**Finding: there is NO `X-Neo-Proxy` shared secret in the deployed Caddyfile.** CLAUDE.md says
identity is "believed only when forwarded by caddy via an `X-Neo-Proxy` shared secret" — that
mechanism is **not actually deployed**. The whole stack trusts forward-auth via **network isolation**:
app containers are only reachable through caddy (internal docker network), and `forward_auth` uses
`trusted_proxies private_ranges`. So for `forward-header` mode:
- **(Recommended) Verify `X-Authentik-Jwt` against the JWKS.** authentik forwards a signed JWT of the
  identity AND `X-Authentik-Meta-Jwks` (the verifying keys). Verifying it is **cryptographic, spoof-
  proof regardless of network path, needs no shared secret, and matches what caddy already sends.**
  Strictly better than `X-Neo-Proxy`; requires no Caddyfile change. Use it.
- **(Fallback) Network-isolation trust** like every other app in this stack. Keep `X-Neo-Proxy` as an
  *optional* extra knob (off by default; the Caddyfile doesn't set it today).
**Build action:** `forward-header` reads `X-Authentik-Uid`/`-Username` and verifies `X-Authentik-Jwt`
via JWKS when present (`FORWARD_AUTH_VERIFY_JWT=true`, default on); falls back to network-trust if
absent. Update CLAUDE.md's auth paragraph to match (§14).

### 1d. The neo-tavern caddy block — CLEAN by design (none of the SillyTavern asset bullshittery)
The live `@sillytavern` block is forced into three hacks; **neo-tavern needs none of them**, and the
build must NOT reintroduce them. Why each disappears:
1. **No hand-maintained static-asset allowlist that skips forward-auth.** ST enumerates
   `/img/* /css/* /js/* /scripts/* /lib/* …` ("ST's actual JS paths") to keep forward-auth's cookie
   dance off parallel asset loads — fragile, breaks on ST updates. neo-tavern splits by a **single
   stable prefix**: `/api/*` is the dynamic surface; **everything else is the SPA bundle**, and
   `/blob/*` is the immutable CAS. Gate by prefix, never by enumerating asset paths.
2. **No `email→username` map / `header_up X-Authentik-Username` rewrite.** ST stores each user's data
   in a **filesystem directory named after the user**, so it must map the authentik identity → a
   stable dir name. neo-tavern has **no per-user directories**: per-user data = `ownerId`-scoped DB
   rows; assets = a **global content-addressed CAS (no `ownerId`, dedup by hash)**. Identity keys on
   the stable `externalId` (`sub`/uid). That entire `map { … }` block is *gone* — structurally.
3. **No `-Clear-Site-Data` ES-module workaround** on our origin: the SPA bundle is served **outside**
   forward-auth (and in `oidc` mode authentik isn't in front of our origin at all), so authentik's
   callback `Clear-Site-Data` never touches our module loads.

**The blocks:**
- **`oidc` mode** (like `@openwebui`/`@grafana`): **no `import authentik`** — the app owns auth. Serve
  everything to `neo-tavern:8788`; the app makes the SPA + `/blob/*` + `/api/auth/*` + `/api/healthz`
  public and requires the session (cookie) only on `/api/trpc/*`. Add `flush_interval -1` + long read/write
  timeouts for SSE (copy the Open WebUI transport block).
- **`forward-header` mode**: run the authentik outpost, but **scope forward-auth to `/api/*` only** —
  serve the SPA bundle + `/blob/*` without it (`handle /api/* { import authentik; reverse_proxy … }`
  then `handle { reverse_proxy … }`). One prefix, stable; no asset-path race, no enumeration.
- **Assets:** `/blob/:hash` is content-addressed, immutable, `Cache-Control: immutable` for a year —
  **capability-by-unguessable-hash**, so it's served publicly (no per-request auth) like a CDN URL;
  acceptable under the homelab trust model (a global blob isn't owned — it's deduped across users).
  No per-user avatar/thumbnail dirs, no thumbnailing config (JIT resize via `sharp` in-app, already
  built: `/api/blob/:hash?w=…&f=webp`). vs ST's per-user `/thumbnails` `/avatars` `/backgrounds`.

Sources: [authentik OAuth2 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/) ·
[forward-auth](https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth/) ·
[property mappings](https://docs.goauthentik.io/add-secure-apps/providers/property-mappings/) — plus
the owner's live `docker-compose.yaml` (Open WebUI ~659-665, Grafana ~1331-1341) + `Caddyfile`
(`(authentik)` snippet ~46-58).

### 1e. Caddy v2 specifics for the neo-tavern block (current best practice + the real gotchas)
The deployment is one app container behind the stack's caddy. Get these right (verified against current
Caddy v2 docs/issues):
- **SSE ⚠️ the headline trap — compression breaks live push.** Caddy auto-flushes recognized streaming
  responses, BUT the **`encode` (gzip/zstd) module buffers SSE and the event never reaches the client**
  ([caddy#6293](https://github.com/caddyserver/caddy/issues/6293)); the stream also only establishes
  after the first upstream byte. The stack's global `encode zstd gzip` would **silently kill push**.
  Fix: set **`flush_interval -1`** on the neo-tavern proxy **and do NOT compress the SSE endpoint**
  (scope `encode` to exclude `/api/trpc` streaming, or mark the stream `Content-Encoding: identity`).
  Long read/write timeouts on the stream (the ST block uses 300s; SSE wants effectively no write
  timeout — rely on the §5a heartbeat to keep it live).
- **SPA caching** ([Caddy patterns](https://caddyserver.com/docs/caddyfile/patterns)): hashed bundle
  assets (Vite `/assets/<name>.<hash>.js`) → `Cache-Control: public, max-age=31536000, immutable`;
  **`index.html` → `no-cache, must-revalidate`** so a new deploy is picked up. `try_files {path}
  /index.html` for client-side routing. (Whoever serves the SPA — the app's Hono `serveStatic` today —
  applies this; if caddy ever serves the bundle directly, replicate it there.)
- **The route split** (mirrors §1d, clean): caddy serves **`/blob/*`** statically + immutable off
  `ASSETS_DIR` (the §-assets block in `docs/subsystems/assets.md`); **proxies everything else** to `neo-tavern:8788`.
  Forward-auth (forward-header mode only) is scoped to **`/api/*`** — never the SPA bundle or `/blob`.
- **CSP** (the auth-review XSS mitigation): set a `Content-Security-Policy` for the SPA — start
  `default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none';
  base-uri 'self'; object-src 'none'` and tighten as the UI lands (Vite needs no inline scripts in
  prod). Reuse/extend the stack's `(security_headers)` snippet (HSTS/nosniff/Referrer-Policy) + add CSP.
- **Upload body size:** import-zip (`POST /api/import/zip`) can be large — set `request_body
  { max_size 1GB }` (or similar) on the neo-tavern site so a proxy cap doesn't truncate a corpus zip
  (the stack already does this for Forgejo at 4GB).
- **Inherited from the stack (keep):** crowdsec bouncer, `rate_limit` (skips private ranges — so LAN
  RP isn't throttled), cloudflare-DNS-01 wildcard TLS, `encode` (minus the SSE carve-out above).
- **HTTP/3:** owner prefers it; the stack's global `servers { protocols h1 h2 }` currently **excludes
  h3** → flip to `protocols h1 h2 h3` (global, one line) + open UDP/443. Block unchanged; SSE works over h3.
- **TLS is free + LAN HTTPS needs no extra cert:** the wildcard `*.inktomi.tech` cert (DNS-01) covers
  `neo-tavern.inktomi.tech` whether it resolves to the WAN or (split-DNS) the LAN IP — so the §5a "LAN
  cert" caveat is moot; just point DNS at the box.
- **Cloudflare-proxied SSE — N/A (confirmed direct):** the owner is **banned from cloudflare proxying**,
  so cloudflare is DNS-only (+ DNS-01 cert) and traffic is direct to the box — **no cloudflare
  buffering/timeout threatens live-push**. Full deploy recipe + the host-vs-container upstream
  (`host.docker.internal:8788` while host-hosted): `docs/auth/auth-deploy.md`.

---

## §2. The auth seam — LAYERED resolution (Part A)

env (`env.ts`): `AUTH_MODE: z.enum(["single-user","forward-header","oidc"]).default("single-user")`
(which SSO mechanism is active) **+** `AUTH_FALLBACK: z.enum(["owner","deny"]).default("owner")` (what
identity an **un-credentialed** request gets). The mechanisms **layer** — this is why "both at once"
works (see below).

**`src/server/auth/trust-header.ts` exposes TWO functions** (do NOT broaden `resolveUsername`'s
signature — it has ~7 call sites: `app.ts` `createContext` + the export/import/asset routes, all
expecting `string`):
- **`resolveIdentity(headers) → { externalId: string|null; handle: string; groups: string[] } | null`**
  — the layered resolver, tried **in order, per request**:
  1. **Session cookie** (when `AUTH_MODE=oidc`): read `__Host-neo_session` from the `Cookie` header → hash →
     `sessions` lookup (exists, not `revokedAt`, not expired, owner `enabled`) → that identity. (§4)
  2. **Forward-auth header** (when `AUTH_MODE=forward-header`): `X-Authentik-Uid` (externalId) /
     `-Username` (handle) / `-Groups`, **trusted by verifying `X-Authentik-Jwt` against the JWKS**
     (`FORWARD_AUTH_VERIFY_JWT`, default on; else network-isolation trust, §1c). (§1b)
  3. **Fallback** (no credential from 1–2): `AUTH_FALLBACK=owner` → `{ externalId:null, handle:
     DEFAULT_USER_HANDLE, groups:[] }`; `AUTH_FALLBACK=deny` → `null` (caller → 401). **CORRECTION
     (BUILT, post-audit):** in an SSO mode the `owner` fallback is **origin-gated** — granted only on a
     LOCAL origin (private/loopback `Host`, or `TRUSTED_LOCAL_HOSTS`); on the public FQDN it returns
     `null` → 401. Without this, `oidc`+`owner` handed every anonymous public request owner+admin. See
     `isLocalOrigin`; the §11 single-user fallback stays unconditional.
- **~~`resolveUsername(headers, …) → string`~~ — REMOVED (post-audit).** It ignored the cookie layer and
  defaulted to `DEFAULT_USER_HANDLE` UNCONDITIONALLY (even under `deny`), so the export/import/asset
  routes that used it were anonymously owner-scoped. Those routes now resolve auth through the SAME seam
  as tRPC — `server/auth-context.ts` `createAuthResolver` + `resolveOwner` (identity required, 401 else;
  CSRF on mutating POSTs). New code needing externalId/groups still calls `resolveIdentity` directly.

**"Both modes at once" (the owner's want):** `AUTH_MODE=oidc` + `AUTH_FALLBACK=owner` = **SSO on the
domain** (a valid `__Host-neo_session` cookie → your SSO identity) **AND owner on the raw LAN IP** (no cookie,
LOCAL origin → fallback to the owner) — *one running process, both behaviors*. The "no cookie → owner"
half is **origin-gated** (above): on the public FQDN a no-cookie request gets `null`→401, NOT the owner,
so the LAN convenience never leaks onto the domain. `AUTH_FALLBACK=deny` makes SSO mandatory everywhere
(no raw-IP owner shortcut). `single-user` = no SSO mechanism + `owner` fallback, unconditional (today).
- **Security knob (the one to get right):** `AUTH_FALLBACK=owner` means **any un-credentialed request
  becomes the owner** — safe ONLY where un-credentialed access is trusted (LAN; the "don't expose 8788"
  invariant). If untrusted clients can reach the un-credentialed path (e.g. a shared LAN, or the raw
  IP exposed), use `deny`. (Note: with `owner` fallback, disabling a user does NOT block them on a
  shared raw-IP path — they'd hit the owner fallback like anyone; that path is "owner", not "them".
  Disable is immediate on the *credentialed* paths via session revocation, §4/§6.)
- **Public routes** (no identity needed, never 401): `/api/healthz`, `/api/auth/*`, the blob CAS.
- **CSRF (cookie path only):** a tRPC middleware on **mutation** procedures requires the custom header
  `x-neo-csrf` (any value); `SameSite=Lax` + this header is the whole CSRF story (§4). Queries/SSE
  (GET) need no header. `Set-Cookie` happens ONLY in `/api/auth/callback` (§10), never at this seam.

## §4. The app session — REVOCABLE SERVER-SIDE, CARRIED IN AN HttpOnly COOKIE (BFF)

**We are a BFF** (confidential OIDC client, server-side) — so we do the thing OWASP + the IETF
*OAuth 2.0 for Browser-Based Apps* BCP recommend for exactly that: the browser↔app session is an
**HttpOnly, Secure, `SameSite=Lax` cookie**, never a JS-readable token. (localStorage bearer is the one
choice a reviewer would flag — any XSS reads it; HttpOnly means an XSS can make requests but **cannot
exfiltrate** the credential. We rejected localStorage for that reason.)
- After the OIDC callback, mint an **opaque** random token (32 bytes, base64url), store only its
  **hash** in a **`sessions`** row (`id`, `userId → users.id`, `tokenHash`, `createdAt`, `lastSeenAt`,
  `expiresAt`, `revokedAt?`, `userAgent`/`label?`), and set it as the session cookie:
  `Set-Cookie: __Host-neo_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…`. The browser
  sends it automatically — including on the **SSE stream** (EventSource sends cookies same-origin), so
  push needs no extra auth plumbing.
- Validate every request by **hashing the cookie → `sessions` lookup**: row exists, not `revokedAt`,
  not past `expiresAt`, and the owning `users.enabled` — else the cookie yields **no identity** (the
  §2 resolver falls through to the next layer / `AUTH_FALLBACK`). **Sliding expiry:** bump
  `expiresAt`/`lastSeenAt` on use. One indexed lookup/request — negligible on one box.
- **CSRF mitigation (small, standard, invisible to the user):** `SameSite=Lax` already blocks
  cross-site POST (and still returns on the top-level OAuth callback redirect — that's why Lax, not
  Strict). Defense-in-depth: require a **custom request header** the app's API client always sets
  (e.g. `x-neo-csrf: 1`) — a cross-site page can't set it without a CORS preflight we don't grant. Keep
  OAuth transaction state (PKCE verifier/`state`/`nonce`) **server-side keyed by `state`**, NOT in a
  cookie, so `SameSite` never interferes with the callback. That is the entire CSRF story.
- **Why server-side sessions, not a stateless JWT:** revocation is *immediate and real* — logout drops
  the row, **disabling a user kills their live sessions now**, and you can list/revoke a specific
  device. Defining the `sessions` schema **now** = no migration later.
- **Non-browser/API clients (future):** if a CLI/script ever needs access, issue a **separate**
  long-lived API token (its own `sessions`-like row, sent as `Authorization: Bearer`). The *browser*
  always uses the cookie. Not built in v1; the seam is the same session store.
- `jose` verifies *authentik's* ID token + the forward-auth `X-Authentik-Jwt` (JWKS) — never our own
  session (opaque + DB-checked). `SESSION_SECRET` HMAC-peppers the `tokenHash` so a DB leak alone can't
  forge a session.
- **Deferred (free — no migration cost):** OIDC refresh-token rotation; sliding sessions + silent
  re-auth cover the UX, and we avoid storing the IdP refresh token. Adding it later is a nullable
  `sessions` column.
- Libraries (not yet deps — add at build): **`openid-client` v6+** (discovery + code exchange +
  ID-token verify — NOTE its API changed substantially from v5; follow the v6 docs, don't copy v5
  snippets) + **`jose`** (verify the forward-auth `X-Authentik-Jwt` against the JWKS). For the opaque
  session token: `node:crypto` `randomBytes` + a SHA-256/HMAC hash — no JWT lib needed for our session.

## §5. Multi-device — and why auth doesn't break push (cookies make it *easier*)
- Each device logs in once (its own session cookie); both resolve to the same user row (same
  externalId) → same owned chats. Phone + desktop are the same origin (the domain) → each just has its
  own cookie jar. The sync dream is intact.
- Convergence (DB-is-canon, stateless per-request) is already true regardless of auth mode.
- **Live push (SSE/subscription) is auth-free to wire:** `EventSource` **sends the session cookie
  automatically, same-origin** — so the stream is authenticated + user-scoped with zero extra work.
  (This is why we no longer need a "short-lived token in the query string" — that hack only existed for
  the bearer design. Gone.) Events flow server→client, keyed by chatId, scoped to the user.

### §5a-push. Push lifecycle — it does NOT "endlessly blast"; keep it simple
An SSE subscription carries events **only for the chat(s) the client has open, only when they actually
change** — an idle open tab receives nothing; it's a cheap held connection, not a firehose. This is
**not** OS push-notifications (we don't build those) — it's "the other open screen updates live."
Standard, homelab-trivial lifecycle (a few devices = a few connections):
- **Heartbeat** `: ping` every ~25s → keeps the connection through caddy (`flush_interval -1` + long
  timeouts) and lets the server detect a dead client.
- **Disconnect cleanup** — tab close / network drop / a phone backgrounding the tab (the OS suspends
  it → connection closes) → the server drops that subscriber. No leaked connections, no drain.
- **Auto-reconnect** — `EventSource` reconnects on drop; on reconnect the client **refetches the chat**
  (DB-is-canon → converges). Self-healing; no missed-event bookkeeping needed.
- **No elaborate inactivity logic needed** at this scale: the browser suspending backgrounded tabs is
  the natural idle-cap. (If a leaked-connection cap is ever wanted, close after N idle hours and let
  the client reconnect on next use — a defensive add, not v1.)

### §5a. Home / LAN access reality (which mode per access path)
SSO works from home like the owner's existing Open WebUI/Grafana OIDC. **`oidc` works on ANY HTTPS
origin you (a) register in authentik's redirect-URI list and (b) include in `OIDC_REDIRECT_URIS`** (§10
derives `redirect_uri` from the request origin), so a **LAN HTTPS host works just as well as the public
domain** — not public-domain-only. authentik is reachable from the LAN regardless (browser + server
both resolve it), so its dependency is fine at home.
- **`oidc`** → over **HTTPS** on the public domain *and/or* a LAN HTTPS host (register both callbacks,
  §10). The session cookie is `Secure`, so HTTPS is required — that's not a downgrade-knob, it's the
  bar for an authenticated session.
- **`forward-header`** → caddy+authentik in front (HTTPS domain path).
- **`single-user`** → ANY path incl. truly bare `http://<lan-ip>:8788` — zero infra, **no session, no
  cookie, no token** (just owner identity), so plaintext-http is fine *because nothing secret rides it*.
**Owner takeaway — both at once (§2):** run `AUTH_MODE=oidc` + `AUTH_FALLBACK=owner`, and a *single
process* serves both: hit the **domain/LAN-HTTPS-host → full SSO** (cookie identity); hit the **raw
`http://<lan-ip>:8788` → you, the owner** (no cookie → owner fallback). No either/or, no per-path
config switch. The only thing that can't happen is an *authenticated* session over plaintext http —
and you don't need one, because the raw-IP path is the owner fallback anyway. (Use `AUTH_FALLBACK=deny`
only if you must forbid the un-credentialed raw-IP shortcut — e.g. a shared/untrusted LAN.)

## §6. User layer (Part B)
- **Admin/owner determination — two sources, group preferred (matches the Grafana pattern):**
  - `OWNER_GROUP` env (e.g. `Neo Owners`): identity's `groups` contains it → `role:'admin'`.
  - `OWNER_HANDLES` env (comma-list, default = `DEFAULT_USER_HANDLE`): handle ∈ list → admin.
  `ensureUser` sets `admin` iff (group matches) OR (handle ∈ OWNER_HANDLES), else `'user'`.
- **`users.externalId`** (new nullable, unique-when-set): authentik `sub`/uid — the stable identity.
  **Do NOT broaden `ensureUser(db, handle): Promise<string>`** — it has ~19 call sites that only have a
  handle (downstream domain services pass `ctx.username`); they must keep working unchanged. Instead add
  a **seam-only** `provisionIdentity(db, { externalId, handle, groups }): Promise<string>` called ONCE,
  at the auth seam (§2 `resolveIdentity` / the OIDC callback), which does the externalId-keyed upsert
  (match by `externalId` if present → update `handle` to the latest `preferred_username`; else by
  handle) + sets `role`/`enabled`, and returns the user id. Downstream `ensureUser(db, handle)` then
  just finds the row. `single-user` keeps using plain `ensureUser` (externalId null, handle =
  DEFAULT_USER_HANDLE).
- **`users.enabled`** (new boolean, default true). Disabled → rejected at §2 **immediately** (the §4
  session check reads `users.enabled` every request + admins should revoke the user's `sessions` rows
  on disable, so a ban takes effect now, not on token expiry). Admins toggle; never hard-delete.
- **tRPC `userAdmin` router** (all `requireAdmin`): `listUsers`, `setRole`, `setEnabled`. No UI.

## §7. Per-user credentials + crypto (Part C, storage half)
- **`src/server/crypto/secrets.ts`** — `encrypt`/`decrypt`, AES-256-GCM, **fresh 12-byte random IV per
  encryption** (never reuse an IV with a key), key = `base64decode(env.CREDENTIALS_KEY)` (32 bytes).
  **Bind AAD = `${userId}|${provider}`** into the GCM seal so a ciphertext row can't be lifted into
  another user's/provider's row and still decrypt. `CREDENTIALS_KEY` unset ⇒ per-user creds **disabled**
  (store rejects writes; resolver falls back to host key). Key lives in env, never the DB. **Key
  rotation is NOT handled** (re-encrypt-all on key change is a future op) — acceptable for homelab, but
  stated, not silent.
- **`user_credentials` table**: `id`, `userId → users.id` (cascade), `provider` (`'openrouter'`),
  `ciphertext`/`iv`/`tag`, `label?`, `createdAt`/`updatedAt`. **Unique `(userId, provider)`.** Plaintext
  key never stored, never returned by any API (only `hasMyOpenRouterKey: boolean`).
- **`domain/credentials` service** + tRPC `credentials` router: `setMyOpenRouterKey`,
  `clearMyOpenRouterKey`, `hasMyOpenRouterKey`. Caller-scoped (not admin).

## §8. The credential resolver — the access chokepoint (Part C, logic half)
`resolveCredential(db, ownerId, source)` →
`{ source:"max-pro-sub" } | { source:"openrouter", openRouterKey } | throws`.
- **`max-pro-sub`** → host `claude login`. Allowed iff `role==='admin'`; else `DomainForbiddenError`.
  No per-user sub. **Replaces the `startChat` handle-guard** — delete that; the resolver covers
  startChat / setProvider / forkChat / every turn uniformly.
- **`openrouter`** → user's decrypted key (BYO, they pay) → else `env.OPENROUTER_API_KEY` (host) →
  else `DomainOperationError("no OpenRouter credential — add your own key in settings")`.

## §9. Wiring the resolver into the turn path (Part C, the invasive bit)
Owner's resolution must stay **byte-identical** (host sub mode 1; host `OPENROUTER_API_KEY` modes
2–4) so existing send/swipe/chat-start tests stay green. Two host-key read sites change:
- `src/server/providers/openrouter/client.ts` — `getOpenRouterClient()` memoizes ONE client from env.
  Refactor to `getOpenRouterClient(apiKey)` caching **per key** (`Map<key, OpenRouter>`) — never leak
  one user's key into another's client.
- `src/server/providers/claude-sdk/config.ts` — mode-2 skin `buildClaudeOpenRouterEnv(<resolved key>,
  overrides)` (already takes the key as arg).
Plumb a resolved-credential field through `runTurn`/`runRawTurn`/`runChatCompletionTurn`; the verbs
(`send.ts`, `swipe.ts`, `compaction.ts`, `lifecycle.ts generateOpening`) call `resolveCredential`
before running and pass it down (`startChat` covered via its `send` delegation). Resolver throw →
existing turn-error path.

## §10. OIDC server routes (Part D) — origin-flexible so IP *and* domain both work
`src/server/auth-oidc.ts`, registered in `buildApp` (like `registerImportRoutes`):
- **`redirect_uri` is DERIVED from the request origin, validated against an allowlist** — NOT a single
  hardcoded domain. Build it from `X-Forwarded-Proto` (caddy sets it; fall back to the request scheme)
  + `X-Forwarded-Host`/`Host` + `/api/auth/callback`, then check it's in `OIDC_REDIRECT_URIS` (the
  allowlist). This is what lets you log in via the **domain OR the LAN IP/host** — you reached the app
  on origin X, the callback returns to origin X, the session cookie is set on origin X. **Never reflect
  an unvalidated Host** into `redirect_uri` (open-redirect / the CVE-2024-52289 class) — allowlist only.
- `GET /api/auth/login` → discovery (cached) → authorize URL (PKCE `code_challenge`, `state`, `nonce`,
  `scope=openid profile email`, the derived+validated `redirect_uri`) → 302. Stash
  verifier/state/nonce/origin keyed by `state` (short-TTL in-memory; single-process assumption).
- `GET /api/auth/callback` → validate state → exchange code (+verifier) at the token endpoint with the
  **same** `redirect_uri` → verify ID token (JWKS, iss, aud, exp, nonce) →
  `ensureUser({ externalId: sub, handle: preferred_username })` → mint the §4 session →
  **`Set-Cookie`** (HttpOnly; Secure; SameSite=Lax) + **302 back to the app** on the originating
  origin. **No token in the URL/fragment** (the cookie carries it — that's the BFF win; the
  fragment-leak risk is gone).
- `POST /api/auth/logout` (clear the cookie; revoke the §4 `sessions` row; hit authentik end-session)
  · `GET /api/auth/me` (resolve the cookie → identity, for the SPA's "am I logged in" probe).
- These routes are exempt from the §2 401 gate.
- **authentik side:** register **every** origin's callback in the provider's redirect-URI list —
  `https://neo-tavern.inktomi.tech/api/auth/callback` AND any LAN **HTTPS** one
  (`https://neo-tavern.lan/api/auth/callback`). Use an **explicit strict list**, not a loose regex
  (CVE-2024-52289: dots aren't escaped).
- **HTTPS-only (no opt-in http):** the session cookie is `Secure`, so OIDC requires HTTPS on every
  origin (public domain + any LAN domain via a LAN cert / caddy). **Raw `http://LAN-IP` is NOT an OIDC
  path** — it's `single-user` (no cookie, no session; §5a). This deletes the earlier
  `OIDC_ALLOW_INSECURE_LAN` knob — authenticated sessions never ride plaintext http.

## §11. WHAT TO AVOID (explicit anti-list — honor every line)
- **NO token in JS-readable storage** — `localStorage`/`sessionStorage`/a JS variable for the session.
  The session is an **HttpOnly cookie** (OWASP/BCP: any XSS would steal a JS-readable token). This is
  the single most important line — it's the thing a reviewer flags.
- **The session cookie MUST be `HttpOnly; Secure; SameSite=Lax`.** Not Strict (Lax is needed for the
  top-level OAuth callback redirect); never non-Secure (no plaintext-http sessions).
- **NO passwords / hashing / salts / local login form.** We are an OIDC *client*, never an IdP.
- **NO heavy CSRF framework** — but DO the small mitigation (§4): `SameSite=Lax` + a required custom
  request header on mutations + server-side PKCE state. Don't *skip* CSRF (cookies need it); don't
  over-build it.
- **NO token / session id in a URL or fragment** (`#token=`, query string) — `Set-Cookie` only. (No
  SSE query-token either; EventSource sends the cookie.)
- **NO storing the IdP's tokens in the browser** — they stay server-side (we're a BFF). No
  refresh-token rotation in v1 (deferred at no migration cost — sliding sessions cover UX, §4).
- **NO plaintext secrets at rest.** AES-256-GCM + AAD only; never log a key; never return one
  (`hasMyOpenRouterKey` boolean only).
- **NO per-user `max-pro-sub`.** Host's single `claude login`; admin/owner only, forever.
- **Do NOT break the zero-infra default.** `single-user` + no `CREDENTIALS_KEY` + no OIDC env + no
  proxy must run exactly like today. Every new env var optional with a safe default / graceful-off.
- **Do NOT regress push / multi-device.** SSE auth = the same-origin cookie (free); keep it that way.
- **Do NOT trust `X-Authentik-*` blindly.** Verify `X-Authentik-Jwt` via JWKS (§1c) or rely on
  network-isolation. **`X-Neo-Proxy` is NOT deployed** — don't assume it exists.
- **Do NOT change the owner's turn resolution.** Owner → host sub / host OR-key, byte-identical.

## §12. Env vars (complete)
- Unchanged: `DEFAULT_USER_HANDLE`, `NEO_PROXY_SECRET`, `OPENROUTER_API_KEY` (now the host OR fallback).
- New: `AUTH_MODE` (default `single-user`; the active SSO mechanism) + **`AUTH_FALLBACK`**
  (`owner`|`deny`, default `owner`; identity for an un-credentialed request — `owner` = SSO-on-domain +
  owner-on-raw-IP coexist, §2); `OWNER_GROUP` (optional) + `OWNER_HANDLES` (default =
  `DEFAULT_USER_HANDLE`); `FORWARD_AUTH_VERIFY_JWT` (default `true`); `CREDENTIALS_KEY` (optional,
  base64 32-byte; unset ⇒ per-user creds off). OIDC-only (required iff `AUTH_MODE=oidc`): `OIDC_ISSUER`
  (`https://authentik.inktomi.tech/application/o/<slug>/`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  **`OIDC_REDIRECT_URIS`** (comma-list **allowlist** of permitted callback origins — the public domain
  + any LAN **HTTPS** origin; §10 derives the per-request one from this; NOT a single fixed URL),
  `SESSION_SECRET` (32+ bytes; HMAC-peppers the session `tokenHash`, §4). `env.ts` refinement:
  `AUTH_MODE=oidc` ⇒ OIDC vars required. (No `OIDC_ALLOW_INSECURE_LAN` — OIDC is HTTPS-only; raw-IP =
  `single-user`.)

## §13. Migrations (`pnpm db:generate:force`)
Define ALL the new schema up front so it's **one migration, no follow-ups** (the "do it right" point):
`users.externalId` (nullable, unique-when-set) + `users.enabled` (boolean default true) +
`user_credentials` table (§7) + `sessions` table (§4: `id`, `userId`, `tokenHash` unique, `createdAt`,
`lastSeenAt`, `expiresAt`, `revokedAt?`, `userAgent?`). No backfill needed (existing owner: externalId
null, enabled true, role already admin from migration 0025; no sessions until first OIDC login).

## §14. Sequencing — each its own green `pnpm check` commit
0. **Schema up front (ONE migration, do-it-right):** define `users.externalId`/`enabled` +
   `user_credentials` + `sessions` (§13) in one `db:generate` so no follow-up migrations are needed;
   later parts just consume the tables.
1. **A+B** — `AUTH_MODE` seam (`single-user` + `forward-header` real, `oidc` stubbed to 401) +
   `OWNER_GROUP`/`OWNER_HANDLES`→admin + `ensureUser({externalId,handle})` + `userAdmin` tRPC
   (incl. `listSessions`/`revokeSession`/`revokeUserSessions`). Additive; multi-account-via-authentik works.
2. **C** — crypto + `user_credentials` + `credentials` tRPC + the resolver + turn-path wiring.
   Behavior-changing core; guard with existing send/swipe/chat-start tests + new resolver tests.
3. **D** — OIDC server routes + the real `oidc` strategy backed by the `sessions` table (mint on
   callback, validate-by-hash per request, sliding expiry, revoke on logout/disable). Frontend deferred.
4. **Docs** — `docs/auth/auth-deploy.md` **already written** (paste-ready Caddy block for both modes + the
   authentik setup checklist + env table — the deploy recipe); CLAUDE.md + `docs/architecture/data-model.md` already
   reconciled to the cookie/BFF model this pass. At build: finish the data-model rows
   (externalId/enabled/user_credentials/sessions) + resolve the 2 CONFIRM-AT-BUILD notes in `docs/auth/auth-deploy.md`
   (the `/blob` path + the exact SSE-encode scope).

## §15. Risk register
- Turn-path resolver refactor on the hot path → owner resolution byte-identical; existing
  send/swipe/chat-start tests are the guard.
- `getOpenRouterClient` singleton → per-key cache: never leak one user's key into another's client.
- `AUTH_FALLBACK=deny` flips "always a fallback identity" → "401 without a credential"; the default
  `owner` keeps the zero-infra/raw-IP behavior. Keep non-SSO defaults untouched and
  the default single-user/zero-infra.
- `CREDENTIALS_KEY` unset must degrade (per-user creds off, host key only), never throw at boot.
- externalId migration: SSO keys on externalId, single-user on handle — `ensureUser` must handle both
  without duplicating rows on a username rename.

## §16. Verification — the three tests that ACTUALLY prove "is it secure"
(The validation that matters is the build + these, not more plan prose.)
1. **Resolver gate:** a `role:'user'` with a stored OpenRouter key generates via the openrouter runner
   using **its** key (assert the per-user key, not `env`); the same user is **refused** `max-pro-sub`
   (`DomainForbiddenError`); an admin/owner gets the host sub. Owner path byte-identical to today.
2. **Session revocation:** a valid cookie authenticates; after `revokedAt` is set (logout) OR the
   owning `users.enabled=false`, the **same cookie is rejected on the very next request** (not after
   expiry); revoking device A's session leaves device B's working.
3. **CSRF behavior:** a same-origin request with the cookie + the custom header succeeds; a
   **cross-site POST without the custom header is rejected** (SameSite + header check); the cookie is
   `HttpOnly; Secure; SameSite=Lax` (assert the `Set-Cookie` attributes on callback).

- **Supporting unit:** crypto round-trip (+ wrong-key fails, + AAD mismatch fails); layered resolver
  (single-user ignores headers; forward-header verifies the JWT / trusts network; oidc reads the
  cookie); **`AUTH_FALLBACK`** (no credential → owner when `owner`, → 401 when `deny`); `provisionIdentity`
  rename (same externalId, new handle → same row, no dup).
- **OIDC leg:** `/callback` with mocked discovery+JWKS+ID-token → `Set-Cookie` + 302 (no token in the
  URL); the resulting cookie authenticates a subsequent tRPC call.
- **Origin-flexible OIDC redirect:** `redirect_uri` is derived from the request origin and accepted
  for an allowlisted origin (domain AND a LAN host both work); an **off-allowlist** origin is rejected
  (no open redirect); `X-Forwarded-Proto: https` yields an `https` redirect_uri behind the proxy.
- `pnpm check` green per commit. Manual: flip `AUTH_MODE`, set a key via tRPC, generate on the per-user
  key; confirm the owner path unchanged.

---

## Amendment (2026-05-30) — `local` password mode + Authelia/custom forward-header + edge belts

The plan above assumed the app **only ever consumes** identity. That is relaxed by **one opt-in mode**
for deployers without authentik/authelia. Everything below rides the *existing* machinery (sessions,
`__Host-` cookie, CSRF, role ladder, `userAdmin`); only how a session is minted is new.

### `AUTH_MODE=local` — username+password accounts (the app as a minimal IdP)
- **Schema:** `users.passwordHash` (nullable; NULL = SSO/owner-fallback account, no local login). One
  additive migration. Format `scrypt$<salt>$<hash>` — `auth/password.ts`, Node `node:crypto` scrypt,
  **per-user salt + a `SESSION_SECRET` pepper** (a DB leak alone can't crack — same posture as the
  session tokenHash and `CREDENTIALS_KEY`). `timingSafeEqual` compare.
- **Routes** (`auth-local.ts`, no-op unless `AUTH_MODE=local`): `POST /api/auth/login` (verify →
  `sessions.create` → `__Host-neo_session` cookie), `POST /api/auth/logout`, `GET /api/auth/me`. Same
  cookie helpers as OIDC (`auth/cookie.ts`). Generic "Invalid credentials" (no user enumeration).
- **Resolver:** the `trust-header.ts` cookie layer now runs for `oidc` **OR** `local`. The `local`
  owner-fallback is **origin-gated** like the SSO modes (LAN convenience; the public host must log in).
- **First owner:** seeded on boot from `LOCAL_INITIAL_PASSWORD` (idempotent — never clobbers a changed
  password). Env refinement requires `SESSION_SECRET` + `LOCAL_INITIAL_PASSWORD` in `local` mode.
- **Management:** admin `createUser` + `resetPassword` on the existing `userAdmin` router (the owner
  changes the seeded password by resetting their own row; reset kicks the user's sessions). Non-admin
  self-service password change is deferred until the frontend lands (needs an authed, not admin, route).

### `forward-header` now also speaks **Authelia** + custom proxies
- Unsigned path reads authentik `X-Authentik-*`, **Authelia `Remote-User`/`Remote-Groups`** (no uid →
  `externalId` null, keyed on handle), or **custom header names** (`FORWARD_AUTH_USER/GROUPS/UID_HEADER`).
- **Opt-in source-IP gate** `FORWARD_AUTH_TRUSTED_PROXIES` (CIDR; client IP from `X-Forwarded-For` /
  `X-Real-IP`): when set, an unsigned identity from outside the ranges is rejected (no `Remote-User`
  spoofing). Unset ⇒ today's network-isolation trust. The **signed authentik-JWT path always skips it.**

### Edge belts (orthogonal, off by default)
- **`IP_ALLOWLIST`** — a Hono middleware in front of everything; 403 outside the CIDRs (loopback always
  allowed). `auth/ip-ranges.ts` is the shared IPv4/IPv6 CIDR matcher.
- **Trusted ranges** now include **Tailscale CGNAT `100.64.0.0/10`** (Docker = RFC1918, already covered);
  `TRUSTED_PRIVATE_RANGES` extends the built-in set for both the origin gate and the proxy gate.
