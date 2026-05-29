# Plan: pluggable auth (single-user / forward-header / OIDC) + user & per-user-credential foundation

> **STATUS: DESIGN LOCKED — not yet built.** This is the spec for the next implementation pass.
> It is intentionally exhaustive so the implementing session cannot misread intent. Read it top to
> bottom before writing code. When in doubt, prefer "the simplest thing that matches §0 and §11 (what
> to avoid)." (Prior settings/lazy-create/import work already shipped — see the git log around the
> `feat(settings)` / `feat(chat)` / `feat(import)` commits.)

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
- **`AUTH_MODE` env enum**: `single-user` (DEFAULT, zero-infra) · `forward-header` (today's
  caddy+authentik) · `oidc` (app is an OIDC client; works on direct LAN too).
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
The verbatim snippet (for `docs/auth.md`):
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

---

## §2. `AUTH_MODE` seam (Part A)

Single env knob selects the identity strategy; **every existing caller of `resolveUsername` stays
unchanged** (keep the signature). `env.ts`:
`AUTH_MODE: z.enum(["single-user","forward-header","oidc"]).default("single-user")`.

Refactor `src/server/auth/trust-header.ts` into a strategy dispatch returning a resolved identity
`{ externalId: string | null, handle: string }`:
- **`single-user`** → always `{ externalId: null, handle: DEFAULT_USER_HANDLE }`. Any auth header is
  ignored. Zero infra. Default.
- **`forward-header`** → read `X-Authentik-Uid` (externalId) + `X-Authentik-Username` (handle) +
  `X-Authentik-Groups`. **Trust = verify `X-Authentik-Jwt` against the JWKS** when present
  (`FORWARD_AUTH_VERIFY_JWT`, default on); else network-isolation trust (§1c). Invalid → 401.
- **`oidc`** → read the **session cookie** (§4), hash → `sessions` lookup → identity. **No/invalid
  session → 401** (this mode has no owner fallback). Public routes: `/api/healthz`, `/api/auth/*`.
- The **disabled-user** check (§6) lives here: resolved → disabled → 401/403.

## §4. The app session — REVOCABLE SERVER-SIDE, CARRIED IN AN HttpOnly COOKIE (BFF)

**We are a BFF** (confidential OIDC client, server-side) — so we do the thing OWASP + the IETF
*OAuth 2.0 for Browser-Based Apps* BCP recommend for exactly that: the browser↔app session is an
**HttpOnly, Secure, `SameSite=Lax` cookie**, never a JS-readable token. (localStorage bearer is the one
choice a reviewer would flag — any XSS reads it; HttpOnly means an XSS can make requests but **cannot
exfiltrate** the credential. We rejected localStorage for that reason.)
- After the OIDC callback, mint an **opaque** random token (32 bytes, base64url), store only its
  **hash** in a **`sessions`** row (`id`, `userId → users.id`, `tokenHash`, `createdAt`, `lastSeenAt`,
  `expiresAt`, `revokedAt?`, `userAgent`/`label?`), and set it as the session cookie:
  `Set-Cookie: neo_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…`. The browser
  sends it automatically — including on the **SSE stream** (EventSource sends cookies same-origin), so
  push needs no extra auth plumbing.
- Validate every request by **hashing the cookie → `sessions` lookup**: row exists, not `revokedAt`,
  not past `expiresAt`, and the owning `users.enabled` — else 401. **Sliding expiry:** bump
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
- Library: `openid-client` (discovery + code exchange + ID-token verify) + `jose` (JWKS verify).

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
**Owner takeaway:** at home, either run a **LAN HTTPS host** (split-horizon DNS / NAT-loopback + a cert,
or just hit the public domain) → full SSO + multi-account; **or** hit the raw LAN IP over http →
`single-user` (you, the owner). Both work; the only thing you can't do is an *authenticated* session
over plaintext http — and you don't need one, since raw-IP is single-user anyway.

## §6. User layer (Part B)
- **Admin/owner determination — two sources, group preferred (matches the Grafana pattern):**
  - `OWNER_GROUP` env (e.g. `Neo Owners`): identity's `groups` contains it → `role:'admin'`.
  - `OWNER_HANDLES` env (comma-list, default = `DEFAULT_USER_HANDLE`): handle ∈ list → admin.
  `ensureUser` sets `admin` iff (group matches) OR (handle ∈ OWNER_HANDLES), else `'user'`.
- **`users.externalId`** (new nullable, unique-when-set): authentik `sub`/uid — the stable identity.
  SSO modes **match/provision by externalId, not handle** (survives username renames); keep `handle`
  synced to the latest `preferred_username`. `single-user` → externalId null, handle =
  DEFAULT_USER_HANDLE. `ensureUser({ externalId, handle })`: match by externalId if present (update
  handle), else by handle.
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
- New: `AUTH_MODE` (default `single-user`); `OWNER_GROUP` (optional) + `OWNER_HANDLES` (default =
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
4. **Docs** — new `docs/auth.md` (full model + verbatim caddy snippet + both neo block shapes),
   CLAUDE.md (already reconciled this pass), `docs/data-model.md` (externalId/enabled/user_credentials/
   sessions — partly done this pass; finish when built).

## §15. Risk register
- Turn-path resolver refactor on the hot path → owner resolution byte-identical; existing
  send/swipe/chat-start tests are the guard.
- `getOpenRouterClient` singleton → per-key cache: never leak one user's key into another's client.
- `oidc` flips "always a fallback identity" → "401 without a token"; keep non-oidc modes untouched and
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

- **Supporting unit:** crypto round-trip (+ wrong-key fails, + AAD mismatch fails); AUTH_MODE dispatch
  (single-user ignores headers; forward-header verifies the JWT / trusts network; oidc 401 without a
  valid cookie); `ensureUser` rename (same externalId, new handle → same row).
- **OIDC leg:** `/callback` with mocked discovery+JWKS+ID-token → `Set-Cookie` + 302 (no token in the
  URL); the resulting cookie authenticates a subsequent tRPC call.
- **Origin-flexible OIDC redirect:** `redirect_uri` is derived from the request origin and accepted
  for an allowlisted origin (domain AND a LAN host both work); an **off-allowlist** origin is rejected
  (no open redirect); `X-Forwarded-Proto: https` yields an `https` redirect_uri behind the proxy.
- `pnpm check` green per commit. Manual: flip `AUTH_MODE`, set a key via tRPC, generate on the per-user
  key; confirm the owner path unchanged.
