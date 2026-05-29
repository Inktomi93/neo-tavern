# Auth & deployment — Caddy block + authentik setup

The **design + rationale** lives in `docs/auth-and-credentials-plan.md` (read it for *why*). This doc
is the **operational recipe**: the finished Caddy block to paste into the stack's Caddyfile, the env
vars, and the authentik setup checklist — so deploying neo-tavern is "paste the block + do authentik."

> STATUS: the **Caddy block is final** (paste-ready). The app-side auth (`AUTH_MODE`, OIDC routes,
> sessions, the credential resolver) is the locked-but-unbuilt plan — build it, then deploy with this.
> A few **CONFIRM-AT-BUILD** notes are flagged inline where a block detail depends on a build choice.

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
| `AUTH_MODE` | all | `single-user` (default) · `forward-header` · `oidc` |
| `DEFAULT_USER_HANDLE` | all | the owner handle (single-user identity + admin) |
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
	reverse_proxy neo-tavern:8788 {
		flush_interval -1
		transport http {
			read_timeout 1800s
			write_timeout 1800s
		}
	}
}
```

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
> **CONFIRM-AT-BUILD:** serve the blob CAS from a path that's easy to keep public. Today the route is
> `/api/blob/:hash` (so it's carved out above); `shared/assets.ts` `blobUrl` emits `/blob/<hash>`. Pick
> ONE at build (a top-level `/blob/*` is cleaner — then the auth split is just "gate `/api/*`" with no
> blob carve-out). If `/blob/*` is used, add a `handle /blob/*` that either proxies the app or
> `file_server`s `ASSETS_DIR` directly (the immutable static block in `docs/assets.md`).
> **CONFIRM-AT-BUILD:** if the tRPC SSE subscription path is known precisely, you may scope `encode`
> to exclude just it; `not path /api/*` is the safe superset (API JSON compression is a negligible loss).

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
   (open a chat on two devices) and that compression didn't eat the SSE stream.
