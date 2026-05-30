# Auth & deployment — Caddy block + authentik setup

The **design + rationale** lives in `docs/auth/auth-and-credentials-plan.md` (read it for *why*). This doc
is the **operational recipe**: the finished Caddy block to paste into the stack's Caddyfile, the env
vars, and the authentik setup checklist — so deploying neo-tavern is "paste the block + do authentik."

> STATUS: **BUILT + deployed.** The app-side auth (`AUTH_MODE`, OIDC routes, sessions, the credential
> resolver) is implemented and verified live through the real caddy+authentik stack; this doc is the
> deploy recipe. The former CONFIRM-AT-BUILD notes are resolved inline. Verification runbook +
> debugging: **`docs/auth/auth-verify.md`** (`pnpm verify:auth`).

## The model in one paragraph
Identity = a pluggable `AUTH_MODE`: **`single-user`** (default, zero-infra: the owner) · **`forward-header`**
(caddy+authentik forward-auth; the app verifies `X-Authentik-Jwt` via JWKS) · **`oidc`** (the app is an
authentik OIDC client; **recommended** — matches how Open WebUI/Grafana/Forgejo run here). The browser
session is an **HttpOnly/Secure/SameSite=Lax cookie** (BFF; revocable server-side `sessions`), CSRF
mitigated by SameSite + a custom header. `max-pro-sub` is owner/admin-only; everyone else brings their
own (encrypted) OpenRouter key. See the plan for all of it.

---

## Env vars (set on the neo-tavern container)
| Var | Mode | Value |
| --- | --- | --- |
| `AUTH_MODE` | all | active SSO mechanism: `single-user` (default) · `forward-header` · `oidc` |
| `AUTH_FALLBACK` | all | un-credentialed request → `owner` (default) or `deny`. **`oidc`+`owner` = SSO on the domain AND owner on the raw LAN IP, at once** — safe because in SSO modes the `owner` fallback is **origin-gated**: granted ONLY on a local origin; on the public FQDN an un-cookied request gets `null` → 401 → SSO. `deny` = SSO mandatory everywhere. In `single-user` mode the fallback is unconditional (the only way in). |
| `TRUSTED_LOCAL_HOSTS` | sso | optional comma-list of extra hostnames counted as a LOCAL origin for the `owner` fallback (a raw-LAN path reached by name, e.g. `neo.lan`). Private/loopback IPs + `localhost` are local already. **Never list the public FQDN here** (that re-opens the bypass). |
| `DEFAULT_USER_HANDLE` | all | the owner handle (single-user / fallback identity + admin) |
| `OWNER_GROUP` | sso | authentik group whose members are admins, e.g. `Neo Owners` (preferred) |
| `OWNER_HANDLES` | sso | comma-list fallback for admins (default = `DEFAULT_USER_HANDLE`) |
| `FORWARD_AUTH_VERIFY_JWT` | forward-header | `true` (verify `X-Authentik-Jwt` via JWKS) |
| `OIDC_ISSUER` | oidc | `https://authentik.inktomi.tech/application/o/neo-tavern/` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | oidc | from the authentik provider (secret stays secret) |
| `OIDC_REDIRECT_URIS` | oidc | allowlist, e.g. `https://neo-tavern.inktomi.tech/api/auth/callback` (+ any LAN HTTPS origin) |
| `SESSION_SECRET` | oidc | 32+ random bytes (HMAC-peppers the session token hash) |
| `CREDENTIALS_KEY` | optional | base64 32-byte AES key for per-user OpenRouter keys (unset ⇒ feature off) |
| `OPENROUTER_API_KEY` | optional | the **host** OpenRouter key (shared fallback) |

---

## Networking, TLS, HTTP/3 (stack-specific)
- **Upstream — where the app runs.** The blocks below proxy to `neo-tavern:8788` (the compose service
  name, for when it's containerized). **FOR NOW the app runs on the host, not in the docker network** →
  caddy (in docker) reaches it via **`host.docker.internal:8788`** (add
  `extra_hosts: ["host.docker.internal:host-gateway"]` to the caddy service), or the docker bridge
  gateway IP. The app must listen on `0.0.0.0:8788`. **Swap `neo-tavern:8788` → `host.docker.internal:8788`
  in the blocks while host-hosted; revert when it moves into the stack.**
- **TLS is free here.** The block is a `handle` inside `*.inktomi.tech`, which already gets a wildcard
  cert via the cloudflare DNS-01 challenge — so `neo-tavern.inktomi.tech` is HTTPS with no extra config.
  **LAN HTTPS for SSO needs no separate cert:** split-DNS `neo-tavern.inktomi.tech` → the LAN IP and the
  same wildcard cert is valid (so the §5a "LAN cert" caveat in the plan is moot — just point DNS at the box).
- **HTTP/3:** enable it **globally** — the stack's Caddyfile currently has `servers { protocols h1 h2 }`
  (h3 OFF); change to `protocols h1 h2 h3` and open **UDP/443**. The neo-tavern block is unchanged
  (protocol is server-level). SSE/live-push works over h3.
- **Cloudflare proxy vs SSE — N/A here (confirmed direct).** The owner is **banned from cloudflare
  proxying**, so traffic never traverses cloudflare's network — cloudflare is **DNS-only** (+ the DNS-01
  cert challenge). So there is **no cloudflare buffering or ~100s idle timeout** in the path → long-lived
  SSE / live push is unobstructed. (If proxying were ever enabled, that timeout/buffering WOULD threaten
  SSE — but it can't be, here.)

## Caddy block — paste inside the existing `*.inktomi.tech { … }` site
It inherits TLS, access logging, `rate_limit` (skips private ranges → LAN RP isn't throttled), and the
crowdsec bouncer from the wildcard site. Mirrors the `@openwebui`/`@grafana` placement.

### `AUTH_MODE=oidc` (recommended — the app owns auth, so the block is trivial)
```caddyfile
@neotavern host neo-tavern.inktomi.tech
handle @neotavern {
	import security_headers
	# SPA XSS mitigation. Tighten/loosen when the chat-render UI lands (e.g. if message markdown
	# embeds remote images, widen img-src or proxy them through /blob).
	header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"

	# Corpus import zips can be large — don't let the proxy truncate POST /api/import/zip.
	request_body {
		max_size 1GB
	}

	# Compress the SPA bundle + JSON, but NEVER /api/* — the SSE stream (tRPC subscription on
	# /api/trpc/*) must not pass through `encode`, or events never flush (caddy#6293).
	@compressible not path /api/*
	encode @compressible zstd gzip

	# Everything → the app: it serves the SPA bundle, /api/*, and the blob CAS. In oidc mode the app
	# owns auth (the cookie session), so there is NO forward_auth here. flush_interval -1 + long
	# timeouts keep live push (SSE) streaming; the app's ~25s heartbeat holds the connection open.
	# DO NOT add `header_up Host …` here: the app's owner-fallback origin gate (below) trusts the
	# original `Host`, so the FQDN must reach the app unmodified.
	reverse_proxy neo-tavern:8788 {
		flush_interval -1
		transport http {
			read_timeout 1800s
			write_timeout 1800s
		}
	}
}
```

> **Why `oidc`+`owner` is safe (the origin gate).** With no `forward_auth`, every request reaches the
> app; an un-credentialed one would, naively, hit the `owner` fallback and be promoted to owner+admin.
> To keep the doc's promise ("SSO on the domain AND owner on the raw LAN IP") **without** that bypass,
> the app gates the fallback by origin (`auth/trust-header.ts` `isLocalOrigin`): in an SSO mode it
> grants `owner` **only** when the request's `Host` is a private/loopback IP literal, `localhost`, or a
> `TRUSTED_LOCAL_HOSTS` name — i.e. the raw-LAN-IP path. On the public FQDN an un-cookied request
> resolves to `null` → 401, so SSO is mandatory there. The non-tRPC routes (`/api/export|import/*`,
> `/api/assets/upload`) go through the **same** seam, so they're not anonymously owner-scoped either.
>
> **Load-bearing assumption:** the `Host` header is trustworthy here because (a) Caddy routes by the
> real `Host` (`@neotavern host neo-tavern.inktomi.tech`), so a spoofed private-IP `Host` never matches
> this site and never reaches the app; and (b) **port 8788 is not publicly routable** (the CLAUDE.md
> deployment invariant). Hence the "DO NOT `header_up Host`" note above. If you ever expose 8788
> directly, set `AUTH_FALLBACK=deny` — the origin gate assumes the invariant holds.

### `AUTH_MODE=forward-header` (alternative — authentik gates at the proxy)
Same shell (`import security_headers` + CSP + `request_body` + the `@compressible`/`encode` lines),
but the single `reverse_proxy` is replaced with an `/api/*` auth split. **The blob CAS + healthcheck
stay public** (an `<img src>` to a blob must not hit the authentik login redirect — that's the ST
static-asset race; we avoid it with a tiny, stable 2-path carve-out, not ST's JS-path enumeration):
```caddyfile
	@api path /api/*
	handle @api {
		# Public under /api: the content-addressed blob CAS (capability-by-hash) + the healthcheck.
		@apipublic path /api/blob/* /api/healthz
		handle @apipublic {
			reverse_proxy neo-tavern:8788
		}
		# Authenticated API: authentik forward-auth injects X-Authentik-* (the app verifies the JWT).
		handle {
			import authentik
			reverse_proxy neo-tavern:8788 {
				flush_interval -1
				transport http {
					read_timeout 1800s
					write_timeout 1800s
				}
			}
		}
	}
	# SPA bundle (everything not /api) — served freely; no forward-auth → no static-asset cookie race.
	handle {
		reverse_proxy neo-tavern:8788
	}
```
> **CONFIRMED (built):** TWO blob paths, both public. The client requests `/blob/<hash>` (`shared/assets.ts`
> `blobUrl`) — served outside `/api/*`, so the SPA-bundle `handle` already serves it freely (caddy maps it
> to `ASSETS_DIR` or proxies the app). The app ALSO serves **`/api/blob/:hash`** (the JIT `?w=…&f=webp`
> resize via `sharp`) — kept public by the `@apipublic path /api/blob/* /api/healthz` carve-out above. No
> change to the block is needed; neither blob path hits forward-auth.
> **CONFIRMED (built):** the only SSE stream is the tRPC **`streamMessages`** subscription at `/api/trpc/*`,
> so `@compressible not path /api/*` already excludes it from `encode` (the safe superset). Narrowing to
> `/api/trpc` is possible but unnecessary — compressing the rest of the JSON API is a negligible loss.

---

## authentik setup — the only remaining manual step

### For `oidc` mode (recommended)
1. **Create an OAuth2/OpenID Provider** (Applications → Providers → OAuth2/OpenID):
   - Client type: **Confidential**. Note the **Client ID + Secret** → `OIDC_CLIENT_ID`/`SECRET`.
   - **Redirect URIs (strict list, NOT a loose regex — CVE-2024-52289):**
     `https://neo-tavern.inktomi.tech/api/auth/callback` (+ any LAN HTTPS origin's callback).
   - Signing key: default; scopes: `openid profile email`.
2. **Create an Application** (Applications → Applications): slug **`neo-tavern`** (→ the `OIDC_ISSUER`
   discovery URL `https://authentik.inktomi.tech/application/o/neo-tavern/`), bind the provider, and set
   the access policy (which users/groups may use neo-tavern).
3. **Owners as admins:** create/choose a group (e.g. **`Neo Owners`**), add your personal + work
   accounts, set `OWNER_GROUP=Neo Owners`. (Members → `role:'admin'` → may use `max-pro-sub`.)
4. **Caddy:** paste the `oidc` block; **no** authentik proxy/outpost needed for this mode.

### For `forward-header` mode (alternative)
1. **Create a Proxy Provider** in **forward-auth (single application)** mode for
   `neo-tavern.inktomi.tech`, bound to an Application; ensure it's served by your existing embedded
   outpost (the one the `(authentik)` Caddy snippet already targets at `authentik-server:9000`).
2. **Caddy:** paste the `forward-header` block (it `import authentik`s on `/api/*`).
3. **Owners as admins:** same `OWNER_GROUP` (the outpost forwards `X-Authentik-Groups`).

### For `single-user` mode
Nothing in authentik. Set `AUTH_MODE=single-user` (default) + `DEFAULT_USER_HANDLE`. The raw
`http://<lan-ip>:8788` path is single-user too (no session, so plaintext-http is fine).

---

## Deploy checklist
1. Build + ship the neo-tavern image into the compose stack (container `neo-tavern`, port `8788`, on
   the caddy network; mount the DB + `ASSETS_DIR` volumes).
2. Set the env vars (above) for the chosen `AUTH_MODE`.
3. Do the authentik setup for that mode (above).
4. Paste the matching Caddy block into `*.inktomi.tech { … }`; `caddy reload` (validates first — a bad
   block keeps the running config).
5. Smoke test: `https://neo-tavern.inktomi.tech/api/healthz` → `{ok:true}`; log in; confirm live push
   (open a chat on two devices) and that compression didn't eat the SSE stream. **The step-by-step
   verification (local probe + the live walkthrough + a debug checklist) is `docs/auth/auth-verify.md`** —
   `pnpm verify:auth` locally, `pnpm verify:auth --remote https://neo-tavern.inktomi.tech` against the deploy.
