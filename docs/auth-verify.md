# Verifying auth end-to-end (the runbook)

A watchable way to confirm the auth foundation (`docs/auth-and-credentials-plan.md`) behaves as
intended, per `AUTH_MODE`, and to debug the real Caddy + authentik wiring. Two layers:

1. **Local probe** — `pnpm verify:auth` fires real HTTP at a running server and asserts the mode's
   behaviors (green/red report). No external deps for `single-user`/`forward-header`; `oidc` session
   mechanics work too (the probe mints a session directly — no authentik needed for that part).
2. **Live deployment** — point the app behind Caddy + authentik and do the real browser login, with a
   read-only `--remote` smoke check + a log-tail you watch.

`env.AUTH_MODE` is parsed once per process, so you verify **one mode per server run** (reboot to switch).
Use an **isolated throwaway DB** so nothing touches your real corpus: `DATABASE_URL=file:./.verify-auth.db`.

---

## 1. Local probe — watch the seam react

In **terminal A**, launch the server in the mode you want (the warmup CUDA/embedder lines are
fire-and-forget — the server listens immediately):

```bash
# single-user (zero infra — the default)
DATABASE_URL=file:./.verify-auth.db AUTH_MODE=single-user DEFAULT_USER_HANDLE=owner \
  pnpm dev:server

# forward-header (set AUTH_FALLBACK=deny so a tampered JWT is a clean reject)
DATABASE_URL=file:./.verify-auth.db AUTH_MODE=forward-header AUTH_FALLBACK=deny \
  DEFAULT_USER_HANDLE=owner pnpm dev:server

# oidc session mechanics (dummy OIDC vars are fine — the probe bypasses the IdP login; discovery is
# lazy, only hit on /api/auth/login). SESSION_SECRET must be 32+ chars.
DATABASE_URL=file:./.verify-auth.db AUTH_MODE=oidc AUTH_FALLBACK=deny \
  OIDC_ISSUER=https://authentik.inktomi.tech/application/o/neo-tavern/ \
  OIDC_CLIENT_ID=dummy OIDC_CLIENT_SECRET=dummy \
  OIDC_REDIRECT_URIS=http://localhost:8788/api/auth/callback \
  SESSION_SECRET=0123456789abcdef0123456789abcdef pnpm dev:server
```

In **terminal B**, run the probe with the **same** `AUTH_MODE`/`DATABASE_URL`/`SESSION_SECRET`:

```bash
DATABASE_URL=file:./.verify-auth.db AUTH_MODE=single-user pnpm verify:auth
```

It prints a checklist you can re-run anytime. Watch terminal A's pino logs alongside — you'll see the
seam react (`user: created tenant row`, `user: provisioned SSO identity`, `session: created`,
`auth: X-Authentik-Jwt verification failed`, the credential-gate refusals). What each mode asserts:

| mode | checks |
| --- | --- |
| `single-user` | healthz public; un-credentialed request → owner (authed query 200); stray `X-Authentik-*` headers **ignored** |
| `forward-header` | a signed `X-Authentik-Jwt` (verified vs the forwarded JWKS) resolves an identity; a **tampered** JWT is rejected (401 under `deny`) |
| `oidc` | a minted session cookie authenticates; **CSRF**: a cookie mutation without `x-neo-csrf` → 403, with it → not blocked; **revocation**: after revoke the same cookie is rejected on the next request |

(The credential-resolver gate — non-owner refused `max-pro-sub`, BYO key used over host — is covered by
`src/server/domain/_shared/credentials.test.ts`; the full OIDC browser login is §2 below.)

---

## 2. Live deployment — real Caddy + authentik

**App placement.** While host-hosted, the app listens on `0.0.0.0:8788`; caddy (in docker) reaches it
via `host.docker.internal:8788` (add `extra_hosts: ["host.docker.internal:host-gateway"]` to the caddy
service). So in the blocks from `docs/auth.md`, swap `neo-tavern:8788` → `host.docker.internal:8788`
until the app moves into the compose stack.

**oidc (recommended).**
1. authentik: create an **OAuth2/OpenID provider** (confidential) + an **Application** with slug
   `neo-tavern`; redirect URI `https://neo-tavern.inktomi.tech/api/auth/callback` (strict list, not a
   loose regex — CVE-2024-52289); scopes `openid profile email`; add your accounts to a group e.g.
   `Neo Owners`. (Full checklist: `docs/auth.md`.)
2. App env: `AUTH_MODE=oidc`, `AUTH_FALLBACK=owner` (SSO on the domain **and** owner on the raw LAN IP)
   or `deny` (SSO mandatory), `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`,
   `OIDC_REDIRECT_URIS=https://neo-tavern.inktomi.tech/api/auth/callback`, `SESSION_SECRET` (32+),
   `OWNER_GROUP=Neo Owners`, `CREDENTIALS_KEY` (base64 32 bytes) if you want per-user keys.
3. Caddy: paste the `oidc` block from `docs/auth.md` (with the `host.docker.internal` swap); `caddy reload`.
4. Smoke it read-only, then log in in a browser:
   ```bash
   pnpm verify:auth --remote https://neo-tavern.inktomi.tech
   ```
   → checks healthz, `/api/auth/me` (no cookie → `authenticated:false`), and `/api/auth/login` → 302 to
   authentik. Then open the domain in a browser → you bounce to authentik → back to the app with a
   `__Host-neo_session` cookie. Confirm in devtools it is **HttpOnly + Secure + SameSite=Lax** and the
   name carries the **`__Host-`** prefix (Path=/, no Domain — the browser host-binds it).

**forward-header (alternative).** Run the authentik outpost; paste the `forward-header` block
(`import authentik` scoped to `/api/*`); set `AUTH_MODE=forward-header`, `OWNER_GROUP`. The app verifies
the forwarded `X-Authentik-Jwt` against the JWKS.

---

## 3. Debugging checklist

- **`/api/auth/login` → 400 "origin not allowed"** — the derived `https://<host>/api/auth/callback`
  isn't in `OIDC_REDIRECT_URIS`. Add the exact origin (proto + host) the browser hits.
- **Login bounces but the session doesn't stick** — the cookie is `Secure`, so it's dropped over plain
  `http`. Use HTTPS (the wildcard `*.inktomi.tech` cert covers the LAN IP via split-DNS too).
- **`auth: X-Authentik-Jwt verification failed`** (forward-header) — the forwarded JWKS doesn't match
  the JWT signer; check the `(authentik)` snippet copies `X-Authentik-Jwt` + `X-Authentik-Meta-Jwks`.
- **Everyone shows up as the owner on the LAN** — that's `AUTH_FALLBACK=owner` on an un-credentialed
  path (intended for the trusted raw-IP path). Use `AUTH_FALLBACK=deny` to forbid it.
- **`max-pro-sub is the owner's credential`** on a turn — the resolver gate: a non-admin can't use the
  host sub; that user needs a BYO OpenRouter key (`credentials.setMyOpenRouterKey`) or an `openrouter` chat.
- **Turn it up:** `LOG_LEVEL=debug` + the `curl`-able `/api/_debug/*` surface (`docs/observability.md`).
- **Live push** — open a chat on two devices; the SSE subscription rides the same-origin cookie. Confirm
  caddy didn't compress it away (`@compressible not path /api/*` + `flush_interval -1`).
