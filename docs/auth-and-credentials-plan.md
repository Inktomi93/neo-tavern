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
  token backed by a `sessions` row, §4), not a throwaway stateless JWT. The bearer the SPA sends as
  `Authorization: Bearer …` has **no ambient credential** for a forged cross-site request to ride →
  **no CSRF, by construction**, with zero CSRF middleware. Server-side = logout/disable/kick-a-device
  take effect *immediately*. "No cookies" is the rule; "session state" is fine. (See §4, §11.)
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
- **Redirect URI convention in this stack:** `https://<app>.inktomi.tech/<callback>` (Open WebUI:
  `…/oauth/oidc/callback`). Ours: `https://neo-tavern.inktomi.tech/api/auth/callback` — register it in
  the authentik provider's redirect allowlist.
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

### 1d. The neo-tavern caddy block (to add; mirror the in-stack patterns)
- `forward-header` mode → like `@uptime`/`@backrest`: `route { import authentik; reverse_proxy
  neo-tavern:8788 }` under `@neotavern host neo-tavern.inktomi.tech`.
- `oidc` mode → like `@openwebui`/`@grafana`/`@forgejo`: **no** `import authentik`, just
  `reverse_proxy neo-tavern:8788` (the app does its own OIDC) + `flush_interval -1` and long
  read/write timeouts for SSE (copy the Open WebUI block's transport settings).

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
- **`oidc`** → read `Authorization: Bearer <token>`, verify the app session token (§4) → its claims.
  **No/invalid token → 401** (this mode has no owner fallback). Public routes: `/api/healthz`,
  `/api/auth/*`.
- The **disabled-user** check (§6) lives here: resolved → disabled → 401/403.

## §4. The app session — REVOCABLE SERVER-SIDE BEARER, NEVER A COOKIE

**CSRF exists only because browsers auto-attach cookies; a bearer token the SPA puts in the
`Authorization` header is never sent on a forged cross-site request → CSRF is structurally impossible,
zero CSRF code.** This holds whether the token is stateless or server-backed — *the point is no
cookie.* We choose **server-backed** (build it right the first time):
- After the OIDC callback, mint an **opaque** random token (32 bytes, base64url) and store only its
  **hash** in a **`sessions`** row: `id`, `userId → users.id`, `tokenHash`, `createdAt`, `lastSeenAt`,
  `expiresAt`, `revokedAt?`, `userAgent`/`label?`. Hand the raw token to the SPA (callback response
  body / redirect fragment — **NOT `Set-Cookie`**); it stores it (memory + `localStorage`) and sends
  `Authorization: Bearer …` on every tRPC call + the SSE stream.
- The `oidc` strategy validates by **hashing the bearer → `sessions` lookup**: row exists, not
  `revokedAt`, not past `expiresAt`, and the owning `users.enabled` — else 401. **Sliding expiry:** bump
  `expiresAt`/`lastSeenAt` on use (long-lived, no nagging re-logins). One indexed lookup/request —
  negligible on one box; memoize with a short TTL only if it ever shows up hot.
- **Why server-side, not a stateless JWT:** revocation is *immediate and real* — logout drops the row,
  **disabling a user kills their live sessions now** (not in up-to-7-days), and you can list/revoke a
  specific device (multi-device management). Defining the `sessions` schema **now** = no migration
  later, which is the whole "do it right the first time" point.
- `jose` is used **only** to verify *authentik's* ID token (OIDC leg) and the forward-auth
  `X-Authentik-Jwt` — never to mint/verify our own session (it's opaque + DB-checked). `SESSION_SECRET`
  optionally peppers the `tokenHash` (HMAC) so a DB leak alone can't forge a bearer.
- **Deferred — and genuinely free to defer (no migration cost):** OIDC **refresh-token rotation**.
  Sliding-expiry sessions + a silent OIDC re-auth cover the UX, and we avoid storing the IdP's refresh
  token (a secret). Adding it later is a nullable column on `sessions` — additive, not debt.
- Library: `openid-client` (discovery + code exchange + ID-token verify) + `jose` (JWKS verify).

## §5. Multi-device — and why auth doesn't break push
- Each device logs in independently, holds its own bearer token, both resolve to the same user row
  (same externalId) → same owned chats.
- Convergence (DB-is-canon, stateless) is already true regardless of auth mode.
- **Live push (SSE/subscription) is orthogonal to auth** — server→client, keyed by chatId, scoped to
  the user. Carries the same bearer (or a short-lived query token where `EventSource` can't set
  headers). SSO + multi-device + live push + no-CSRF all coexist.

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
- **`src/server/crypto/secrets.ts`** — `encrypt`/`decrypt`, AES-256-GCM, 12-byte random IV, key =
  `base64decode(env.CREDENTIALS_KEY)` (32 bytes). `CREDENTIALS_KEY` unset ⇒ per-user creds **disabled**
  (store rejects writes; resolver falls back to host key). Key lives in env, never the DB.
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

## §10. OIDC server routes (Part D)
`src/server/auth-oidc.ts`, registered in `buildApp` (like `registerImportRoutes`):
- `GET /api/auth/login` → discovery (cached) → authorize URL (PKCE `code_challenge`, `state`,
  `nonce`, `scope=openid profile email`, `redirect_uri`) → 302. Stash verifier/state/nonce keyed by
  state (short-TTL in-memory; single-process assumption like AppConfig).
- `GET /api/auth/callback` → validate state → exchange code (+verifier) → verify ID token (JWKS, iss,
  aud, exp, nonce) → `ensureUser({ externalId: sub, handle: preferred_username })` → mint §4 bearer →
  return to SPA (redirect `#token=…` or postMessage).
- `POST /api/auth/logout` (hit authentik end-session; SPA drops token) · `GET /api/auth/me`.
- These routes are exempt from the §2 401 gate.

## §11. WHAT TO AVOID (explicit anti-list — honor every line)
- **NO cookie sessions.** Bearer in `Authorization` only. (The whole CSRF-avoidance strategy.)
- **NO CSRF middleware/tokens.** Not needed given bearer-only.
- **NO passwords / hashing / salts / local login form.** We are an OIDC *client*, never an IdP.
- **NO `Set-Cookie` / cookie sessions / express-session.** The bearer lives in `Authorization` only.
  (Server-side **session state is YES** — a revocable `sessions` table backing the opaque bearer, §4.
  The thing we avoid is *cookies*, not session state. Don't conflate them.)
- **NO refresh-token rotation in v1** — deferred at *no* migration cost (sliding-expiry sessions cover
  UX; adding it later is a nullable `sessions` column, §4). Not debt.
- **NO plaintext secrets at rest.** AES-256-GCM only; never log a key; never return one (boolean only).
- **NO per-user `max-pro-sub`.** Host's single `claude login`; admin/owner only, forever.
- **Do NOT break the zero-infra default.** `single-user` + no `CREDENTIALS_KEY` + no OIDC env + no
  proxy must run exactly like today. Every new env var optional with a safe default / graceful-off.
- **Do NOT regress push / multi-device.** Keep SSE/subscription auth-agnostic; don't couple to cookies.
- **Do NOT trust `X-Authentik-*` blindly.** Verify `X-Authentik-Jwt` via JWKS (§1c) or rely on
  network-isolation. **`X-Neo-Proxy` is NOT deployed** — don't assume it exists.
- **Do NOT change the owner's turn resolution.** Owner → host sub / host OR-key, byte-identical.

## §12. Env vars (complete)
- Unchanged: `DEFAULT_USER_HANDLE`, `NEO_PROXY_SECRET`, `OPENROUTER_API_KEY` (now the host OR fallback).
- New: `AUTH_MODE` (default `single-user`); `OWNER_GROUP` (optional) + `OWNER_HANDLES` (default =
  `DEFAULT_USER_HANDLE`); `FORWARD_AUTH_VERIFY_JWT` (default `true`); `CREDENTIALS_KEY` (optional,
  base64 32-byte; unset ⇒ per-user creds off). OIDC-only (required iff `AUTH_MODE=oidc`): `OIDC_ISSUER`
  (`https://authentik.inktomi.tech/application/o/<slug>/`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_REDIRECT_URI` (`https://neo-tavern.inktomi.tech/api/auth/callback`), `SESSION_SECRET`.
  `env.ts` refinement: `AUTH_MODE=oidc` ⇒ OIDC vars required.

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

## §16. Verification
- **Unit:** crypto round-trip (+ wrong-key fails); resolver (host-key; BYO uses stored key not env;
  max-pro-sub forbidden for `user`, allowed for `admin`); AUTH_MODE dispatch (single-user ignores
  headers; forward-header verifies the JWT/trusts network; oidc 401 without/with-invalid token, ok
  with a valid signed bearer); `ensureUser` rename (same externalId, new handle → same row).
- **Integration:** a `role:'user'` with a stored OpenRouter key generates via the openrouter runner
  using **its** key (assert the per-user key, not env) and is **refused** `max-pro-sub`; OIDC
  `/callback` with mocked discovery+JWKS+token mints a usable bearer that authenticates a tRPC call.
- **Session revocation (the build-it-right guarantee):** a valid bearer authenticates; after
  `revokedAt` is set (logout) OR the owning `users.enabled=false`, the **same bearer is rejected on the
  very next request** (not after expiry); a second device's session is unaffected by revoking the first.
- `pnpm check` green per commit. Manual: flip `AUTH_MODE`, set a key via tRPC, generate on the per-user
  key; confirm the owner path unchanged.
