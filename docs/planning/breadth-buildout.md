# Breadth build-out — security, corpus analytics, type-safety

**What this is.** A self-contained, implement-from-cold spec for three tracks that a
neo-tavern↔SillyTavern audit flagged as the remaining places we "lose points." It is written so a
fresh session can pick up ANY track and build it **without the originating conversation**. Every
current-state claim is cited `file:line`; every proposal is grounded in code that exists in this repo
or in `references/` (the answer-keys). Build ambitiously (feature-breadth, not YAGNI) — these three
are mission-aligned: corpus analytics is the stated **killer differentiator**, security is real
hardening, type-safety is the rigor bar.

**The three tracks (and why):**
- **Track A — Security: SSRF + hardening.** The app makes outbound HTTP with zero egress guard, and
  has no rate limiting. Two concrete holes vs ST.
- **Track B — Corpus RAG analytics.** The RAG *engine* is built + validated; the headline *product*
  (co-occurrence, theme analysis, duplicate detection) is "plumbing-not-product." This is the
  differentiator no other ST client has.
- **Track C — Type-safety.** ~14 real type-escapes (`z.any()`, post-Zod `as` casts, untyped DB JSON
  reads) weaken the otherwise end-to-end-typed stack.

**How to use this doc.** Pick a track. Read its "Current state" first (it's accurate as of writing —
re-verify the `file:line`s, code drifts). Then implement in the listed order, **commit-per-step**,
keeping `pnpm check` green. See "Working discipline" at the bottom — it's load-bearing (layer cake,
migrations, the vector-index lesson, Serena editing).

---

## Working discipline (read once, applies to all tracks)

- **BUILD IT IN FULL — DO NOT PUSS OUT.** These tracks are deliberately feature-breadth, NOT YAGNI.
  Do not stub it, do not ship the quick-and-dirty 80%, do not silently narrow scope to dodge the hard
  part (the undici egress hook, the in-process k-means, the branded-ID churn, the all-pairs matmul).
  "Hard/big" is not a reason to skip — it's a reason to split into commits and build the whole thing.
  If you genuinely believe a piece should be cut, SAY SO EXPLICITLY and why — never quietly downgrade.
  We set out to do cool shit; do the cool shit.
- **USE SERENA'S SYMBOLIC TOOLS for quick ops — do not default to read-the-whole-file + hand-rewrite.**
  Serena is the active LSP. Inventory with `search_for_pattern`; navigate with `get_symbols_overview`
  + `find_symbol`(include_body); edit with `replace_content` / `replace_symbol_body` /
  `insert_before_symbol` / `insert_after_symbol` (no prior Read needed, exact-match safe). These are
  faster and more precise than the generic file tools. (Caveat: `get_diagnostics_for_file` can be STALE
  right after you edit a type-definition file — the LSP doesn't reload dependents — so trust a fresh
  `tsc` over it.)
- **Green-to-ship:** `pnpm check` = biome + `tsc --noEmit` + `pnpm arch` (dependency-cruiser) + vitest.
  Must be green before every commit. Commit directly to `main`, one logical step per commit, with the
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Layer cake (enforced by `.dependency-cruiser.cjs`):** `shared`/`db` are foundation. `domain`
  features expose a front-door `index.ts`; callers never reach internals; features don't import each
  other. tRPC routers are THIN (validate → call `ctx.services.*` → map domain errors); they can't
  import `db`/infra. **Infra (auth, egress hooks) CANNOT import domain** — this bites Track A's audit
  trail (use pino + an injected port). Run `pnpm arch` after structural changes.
- **Migrations:** migrations are squashed to a single `src/db/migrations/0000_baseline.sql`. A new
  schema change = edit `src/db/schema/*.ts` → `pnpm exec drizzle-kit generate --name <x>`. **Vector
  tables:** declare the ANN index in-schema as an expression index —
  `index("<t>_ann").on(sql`libsql_vector_idx(embedding)`)` (literal column, not `${t.col}`); see
  `src/db/schema/search.ts` for the pattern. Clear a vector table ONLY via `clearVectorTable`
  (`src/db/vector-ops.ts`) — a bare `DELETE FROM` poisons the DiskANN shadow table. Existing DBs on
  deploy run `pnpm db:baseline` once (see `scripts/db-baseline.ts`).
- **Time:** epoch-ms UTC everywhere; `src/shared/time.ts` is the only parser. Relevant to Track B's
  timeline (the `msgMidAt` gap below).
- **TS strictness:** `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are ON. Optional object
  props that may be `undefined` must be typed `T | undefined` (not bare `T?`). Array/typed-array index
  access is `T | undefined`.
- **Config tiers:** new deploy/secret knobs → `src/server/env.ts`. New admin-runtime knobs →
  `src/shared/app-settings.ts` + `src/server/config/app-config.ts`. Per-user → `src/shared/user-settings.ts`.

---

# Track A — Security: SSRF + hardening

> **✅ TRACK A CORE — DONE (2026-05-30).** Shipped to `main`, each its own green `pnpm check` commit:
> - **A.2.0** (auth-flexibility foundation): `AUTH_MODE=local` (password accounts, env-seeded owner),
>   `forward-header` accepts Authelia `Remote-*` + custom headers + opt-in `FORWARD_AUTH_TRUSTED_PROXIES`
>   source-IP gate, `IP_ALLOWLIST` edge belt, Tailscale CGNAT in the trusted ranges (`auth/ip-ranges.ts`).
> - **A.2.3** security headers (CSP/HSTS/frame/COOP, dev-permissive/prod-strict, HSTS off for single-user).
> - **A.2.4** per-route body limits + zip-bomb guard (per-entry/total decompressed caps).
> - **A.2.6** JWKS hardening (https + host-allowlist on the meta-jwks URL) + opt-in jwtVerify iss/aud.
> - **A.2.1** SSRF egress firewall (undici `setGlobalDispatcher` + private-IP-rejecting DNS lookup,
>   rebinding-safe; `EGRESS_FIREWALL`/`EGRESS_ALLOWLIST`; OIDC issuer auto-allowed).
> - **A.2.2** per-user rate limiting (`rate-limiter-flexible`; general 120/min + ai-turn 30/min on
>   send/swipe/start, keyed on handle) + a bespoke login-route limiter.
> - **A.2.5** consistent `securityEvent()` pino trail (greppable `security:true`+`event`); DB-persisted
>   security audit deliberately skipped for a single-operator box.
>
> Plus a 3-agent adversarial review pass (commit `a7cb7db`): constant-time login floor, login
> body-limit+throttle, empty-CIDR fail-open fix, logout CSRF, trusted-proxy-aware IP allowlist.
> The §A.2 spec below is the as-designed reference (file:line since drifted). Remaining = the A.3
> nice-to-haves (login-IP limit, global ceiling, outbound logging, `pnpm audit` in check).

## A.1 Current state (verified `file:line`)

**Egress — zero SSRF protection.** All outbound is `fetch`/undici. Call sites:
- `src/server/providers/openrouter/client.ts` — `@openrouter/sdk`, base URL env-fixed (`openrouter.ai`, public). Not user-controlled.
- `src/server/auth-oidc.ts` — `client.discovery(new URL(env.OIDC_ISSUER))` + token grant; issuer env-fixed.
- `src/server/auth/trust-header.ts:119` — `createRemoteJWKSet(new URL(trimmed))` where `trimmed` comes from the **`X-Authentik-Meta-Jwks` request header**. **This is the lone live user-influenced egress vector** (only reachable if the `forward-header` network-trust assumption breaks).
- `src/server/embeddings/embedder.ts:11-12` — `hf.allowRemoteModels = true`, downloads from HF CDN (public). Model IDs hardcoded.

**No rate limiting anywhere.** No body-size limits (`src/server/app.ts`; `import-http.ts:159` `parseBody` unbounded). No throttle on tRPC mutations or on `/api/auth/login`+`/callback` (`auth-oidc.ts`). NOTE: the OIDC callback already requires a matching in-memory PKCE `state`, so brute-force there is moot; **authentik owns credential brute-force**. The real value of rate-limiting here is **GPU/LLM-spend throttling**.

**No security headers** — no CSP/HSTS/X-Frame-Options/X-Content-Type-Options (zero hits for `secureHeaders|helmet|cors`).

**Audit substrate exists but unused for security:** `auditLogs` table (`src/db/schema/audit.ts`) + `logAudit` (`src/server/domain/_shared/audit.ts`) are used for domain mutations; security events (SSRF block, CSRF reject, auth fail, rate-limit) are not wired. `logAudit` requires a non-null `entityId` (security events often lack one) → schema relaxation needed.

**IP lies behind Caddy** (`src/server/observability/debug.ts:83` notes this). IP-keying only works on the pre-auth `/api/auth/login` via Caddy's `X-Forwarded-For`. Everything authed must key on resolved identity (`ctx.auth`).

**Timing-safe:** `timingSafeEqual` used correctly for `DEBUG_TOKEN` (`debug.ts:1,33`); session `tokenHash` is HMAC-peppered. No raw secret string-compares. Posture is fine.

## A.2 Build-out

### A.2.1 SSRF egress firewall — **CORE, effort M**
**Critical:** ST's `private-request-filter.js` replaces `http.globalAgent`; **Node 24 `fetch`/undici ignore that** — porting it = silent no-op. Correct seam = `undici.setGlobalDispatcher(new Agent({ connect: { lookup } }))`. The custom `lookup` resolves DNS and rejects private IPs; passing the resolved address straight to connect closes the DNS-rebinding TOCTOU.

New file `src/server/infra/egress-firewall.ts`:
```ts
import { lookup as dnsLookup } from "node:dns";
import { setGlobalDispatcher, Agent } from "undici";   // add `undici` as an explicit dep (TS resolution)
import { getLog } from "../observability/logger";
// Reuse the private-range logic already in src/server/auth/trust-header.ts (isPrivateOrLoopbackHost).
// Block: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (incl. 169.254.169.254 metadata), ::1, fc00::/7, fe80::/10.
export function installEgressFirewall(allowlist: string[]): void {
  setGlobalDispatcher(new Agent({ connect: { lookup(hostname, opts, cb) {
    dnsLookup(hostname, (err, address, family) => {
      if (err) return cb(err, address, family);
      if (isPrivateAddress(address) && !allowlist.includes(hostname)) {
        getLog().warn({ hostname, address }, "security: egress SSRF blocked");
        return cb(new Error(`SSRF_BLOCKED: ${hostname} → ${address}`), address, family);
      }
      cb(null, address, family);
    });
  } } }));
}
```
- Install as the **first** non-trivial statement in `src/server/index.ts` (before `buildApp`).
- **Allowlist:** only the OIDC issuer host needs it (e.g. `auth.lan`). New env `EGRESS_ALLOWLIST` (comma-list) + surface as an AppSettings knob (`egressAllowlist: string[]`) so the owner can add internal hosts at runtime.
- **Belt-and-suspenders / RISK:** if `@openrouter/sdk` or `openid-client` v6 instantiate their own undici `Pool`, they bypass `setGlobalDispatcher`. Both `openid-client` `discovery` and `jose` `createRemoteJWKSet` accept a custom `fetch`/`[customFetch]` — wire an egress-checking fetch there too as a redundant layer. **Add a test that a request from each lib is intercepted.**

### A.2.2 Rate limiting — **CORE (B1), effort S**
Library: `rate-limiter-flexible` (in-process `RateLimiterMemory`, ST's choice, no Redis). New `src/server/trpc/rate-limit.ts`. Two limiters, both keyed on `ctx.auth.identity?.handle` (NOT IP):
- `generalMutationLimiter` (~120/min) on `authedProcedure` mutations.
- `aiTurnLimiter` (~20/min) additionally on `chat.send`/`chat.swipe`/`chat.generateOpening` (the GPU/$ guard — the real point).
On limit: `throw new TRPCError({ code: "TOO_MANY_REQUESTS" })`. Wire as a tRPC middleware on the procedure ladder in `src/server/trpc/trpc.ts`.
- **B2 (nice-to-have):** `/api/auth/login` IP-keyed limit (~10/min) via Caddy's `X-Forwarded-For`. Low value (authentik owns brute-force).
- **B3 (nice-to-have):** global request ceiling via a Hono middleware. Belt for a LAN box; set high.

### A.2.3 Security headers — **CORE, effort XS**
`hono/secure-headers` (no new dep). Add in `src/server/app.ts` after the observability middleware: CSP (`defaultSrc 'self'`; `styleSrc 'self' 'unsafe-inline'` for Tailwind), `xFrameOptions: DENY`, `xContentTypeOptions`, HSTS, `referrerPolicy`. **Gate HSTS behind `env.AUTH_MODE !== "single-user"`** (single-user is plain-http LAN). **CSP is iterative** — `scriptSrc 'self'` is correct for a chunked Vite prod build but may need a nonce/`'unsafe-inline'` once the frontend lands; ship a permissive dev CSP + strict prod CSP, tighten per frontend PR.

### A.2.4 Body limits + zip-bomb guard — **CORE, effort XS**
`hono/body-limit` **per-route** (a global limit breaks import): tRPC 1MB, asset upload 50MB, import zip 512MB (tune), import cards/chats 50MB. In `src/server/import-http.ts` the existing zip-slip guard (~`:154-165`) has **no decompressed-size check** — add a per-entry + total-decompressed-bytes counter in the unzip loop (zip-bomb defense). Land with the body limits.

### A.2.5 Security-event audit trail — **CORE (partial), effort S**
**Layer-cake:** infra (egress hook, CSRF gate) can't import domain `logAudit`. Use **pino** for infra events (the logger is foundation-layer, already redacts `cookie`/`token`/`apiKey`). For domain-layer DB-audit writes, inject a `SecurityAuditPort` interface at the composition root (same pattern as `DbInspector` in `debug.ts`). Events: SSRF block (egress hook, pino), CSRF reject (`trpc.ts` authMiddleware), rate-limit hit, failed OIDC exchange (`auth-oidc.ts:118`, add `event:"auth_failed"`), disabled-account reject (`auth-oidc.ts:140`), JWKS verify fail (`trust-header.ts:160`). Relax `logAudit`'s `entityId` to `string | null` (`audit.ts` + schema + migration) and add a `security` domain value.

### A.2.6 JWKS hardening — **CORE, effort S**
After the firewall: in `src/server/auth/trust-header.ts`, pre-flight the `X-Authentik-Meta-Jwks` URL (require `https:` + host ∈ allowlist) before `createRemoteJWKSet`. New env `FORWARD_AUTH_JWKS_ALLOWLIST` (default = OIDC issuer host). Add `issuer: env.OIDC_ISSUER` (and `audience: env.OIDC_CLIENT_ID` if present) to the `jwtVerify` options — `iss`/`aud` are currently unchecked (two lines).

## A.3 Cool-shit breadth
- **Outbound request logging** (debug-level): log `{method,url,status,ms}` from an extra dispatcher interceptor — diagnoses OpenRouter routing + model-download stalls.
- **Host-header allowlist** (`ALLOWED_HOST_NAMES`) — Caddy already does this; belt for the raw-LAN-IP path.
- **`pnpm audit --audit-level=high`** added to `pnpm check` — CVE surfacing without CI (one line).
- **Account lockout** — OVERKILL for the homelab (authentik owns it); skip unless multi-user grows.

## A.4 Sequencing (A)
1. Security headers (XS) + body limits & zip-bomb guard (XS) — independent, land together.
2. Per-user rate limiting (S) — needs `rate-limiter-flexible`.
3. SSRF egress firewall (M) — needs `undici` dep, affects `index.ts` boot order.
4. JWKS hardening (S) + `jwtVerify` iss/aud (XS).
5. Security-event audit trail (S) — after 2+3 so events exist.
6. Nice-to-haves (login limit, global ceiling, outbound logging, host allowlist, pnpm audit).

**Files touched:** new `src/server/infra/egress-firewall.ts`, `src/server/trpc/rate-limit.ts`; modified `src/server/index.ts`, `src/server/app.ts`, `src/server/trpc/trpc.ts`, `src/server/auth/trust-header.ts`, `src/server/auth-oidc.ts`, `src/server/import-http.ts`, `src/server/env.ts`, `src/shared/app-settings.ts` + `src/server/config/app-config.ts`, `src/db/schema/audit.ts` + `src/server/domain/_shared/audit.ts` (+ migration). Deps: `undici`, `rate-limiter-flexible`.

## A.5 Risks
undici global-vs-library dispatcher (test interception). CSP vs Vite build (iterate). Zip-bomb size cap tuning. Rate-limit middleware must sit on `authedProcedure` (identity present), not `publicProcedure`. Audit from infra violates the layer cake (pino + injected port). `logAudit` entityId nullability (migration). Most of B2/B3/lockout are belt for a single-user LAN box — build the knobs, set them loose.

---

# Track B — Corpus RAG analytics (the differentiator)

## B.0 — card-curator answer-key: what each prior system DOES / CALCULATES (rebuild reference)
`references/card-curator` (a prior project of ours — ChromaDB + Qwen3-VL embeddings, an MCP tool
server) already BUILT most of this analytics surface. This is the rebuild map: what each system
computes, where it lives, and the neo target. **Port the LOGIC/calculations, not the storage/model
glue** — card-curator embeds Qwen3-VL into ChromaDB; neo uses BGE-M3 in libSQL.

| System — what it computes | card-curator `file:line` | neo target / status |
|---|---|---|
| **CSLS hub score** = mean cosine to K=10 nearest same-set neighbors (exact `embs @ embs.T`, zero self, top-K mean) | `index.py:62` `_compute_hub_scores` | ✅ DONE — `corpus/hubness.ts` |
| **Resumable embed+index** with content-hash change detection (skip unchanged on re-run) | `index.py:144` `build_index` (+ hashes `:107-133`) | ✅ DONE — `scripts/embed-corpus.ts` + `existingKeys` |
| **Duplicate detection** — all-pairs sim, keep pairs ≥ threshold (default **0.92**), dedupe (A,B)/(B,A), sort desc, top-N; `by` text\|image; `sim = 1 − dist/2` | `server.py:926` `find_duplicates` | **Pillar C** — port the threshold/dedupe logic; use the exact matmul (per B.7), not per-row search |
| **"More like this"** — kNN by text OR image embedding | `server.py:663` `similar_cards` | **Breadth** — `similarCards` / `similarChats` |
| **Genre classification** — per-card LLM → `{primary_genre, sub_genres[], tone, setting}` (GENRE_SCHEMA) | `analyze.py:135` `classify_genre` | **Theme route A** (per-card tags) + tag auto-suggest |
| **Card summary** — 2–3 sentence LLM summary | `analyze.py:149` `summarize_card` | Breadth (card preview) |
| **Card comparison** — LLM → `{similarities, differences, redundancy_score 0–1, verdict}` (COMPARISON_SCHEMA) | `analyze.py:160` `compare_cards` | **Breadth** — pairs with dedup ("compare these two") |
| **Arbitrary-schema Q&A** over a card (JSON-schema-constrained local model) | `analyze.py:101` `ask_about_card` / `server.py:876` | Breadth; the pattern theme-naming reuses |
| **Bulk LLM analysis** over many cards | `server.py:1434` `batch_analyze` | Breadth (theme naming = this pattern) |
| **Per-character stats** — totals (chats/main/branch, messages user/char, swipes), word & token counts, first/last date, **every message datetime**, `models_used{}`, `apis_used{}`, reasoning count+duration, gen-time & TTFT tallies | `chats.py:236` `CharacterStats` + `:556` `get_chat_stats` + `:492` `_aggregate_chat_files` | **Breadth** `characterProfile` — compute from neo DB rows (`messages`/`chats`), NOT JSONL re-parse |
| **Popularity ranking** — rank characters by engagement | `chats.py:587` `get_popularity_ranking`; `server.py:745` `chat_popularity` | Breadth (dashboard) |
| **Character detail** — one character's full aggregate | `chats.py:615` `get_character_detail`; `server.py:766` | Breadth `characterProfile` |
| **Activity by time** — message counts by **day-of-week** & **hour-of-day** + top-5 chars per bucket | `chats.py:704` `get_activity_by_time`; `server.py:1333` `chat_timeline`, `:1396` `chat_activity` | **The timeline answer-key** (needs `msgMidAt`) + dashboard heatmap |
| **Per-model usage** across the corpus | `server.py:1279` `model_summary`; `chats.py:331` `_tally_model_api` | Breadth `corpusStats` (neo reads `messages.model`) |
| **Unused cards** — cards with zero chats | `server.py:1219` `find_unused_cards` | **"Forgotten gems"** (richer: low-revisit, not just zero) |
| **Semantic chat search + raw click-through** | `server.py:994` `search_chats` + `:1161` `get_chat_context` | ✅ DONE — `search.corpus`/`discover` + seq spans |
| **Chat segmentation at user/char PAIR boundaries** (a user msg + reply = one unit) | `chat_index.py:68` `segment_chat` + `:48` `_is_pair_boundary` | Reference — neo uses fixed `blockSize=8` (`memory/generate.ts`); pair-boundary is the option if block edges feel arbitrary |
| **Separate stats index/collection** | `chat_index.py:492` `build_stats_index` | neo keeps stats as live SQL aggregates (no separate index) |

**NOT in card-curator → these are neo-ORIGINAL (build fresh, no port):**
- **Keyword×keyword co-occurrence** (Pillar A) — card-curator has none; neo builds it on `chat_digests.keywords`.
- **Emergent theme CLUSTERING via k-means** (Pillar B) — card-curator does themes the SIMPLE way: per-card LLM `classify_genre` tags. So neo has TWO routes: **(A) port `classify_genre`** (proven, simple, per-card tags — good first cut, immediately feeds tag auto-suggest) and **(B) k-means emergent clustering** of digest embeddings (richer, neo-new, surfaces themes nobody labeled). Recommend A first, B as the deeper layer.
- card-curator is per-CARD; neo extends the SAME calculations to CHATS / digests / segments (more substrate).

## B.1 Current state — what the engine already gives you (`file:line`)
- **Character embeds:** `src/server/domain/corpus/service.ts` (`embedAndStore`/`embedAndStoreMany`/`existingKeys`) → `character_embeddings` (1024-dim, model-tagged). Targets from `src/server/domain/corpus/targets.ts` + `embed-text.ts`. Resumable GPU pass `scripts/embed-corpus.ts`.
- **Chat memory substrate (live, incremental):** `src/server/domain/chat/memory/generate.ts` — `generateDigests` (LLM-summarized tier-0 blocks of `blockSize=8`, + consolidation tiers 1–3) → `chat_digests` (with `topicAnchor`, `keywords[]`, `seqStart/seqEnd`, `hubScore`); `generateSegments` (embed-only, full coverage) → `chat_segments`. Backfill: `scripts/memory-backfill.ts`.
- **CSLS hubness:** `src/server/domain/corpus/hubness.ts` — `computeCharacterHubScores`/`computeDigestHubScores`/`computeSegmentHubScores`, exact pairwise cosine top-K mean per (type,model) via `computeGroupHubs` (loads vectors in-process, L2-normalizes, full dot-product matrix). Run by `scripts/csls.ts`. **This already computes the pairwise matrix dedup needs.** Ported from `references/card-curator/src/card_curator/index.py:62-89`; cross-ref `references/st-bridge/src/st_bridge/embeddings.py:149-177`.
- **Search (live tRPC, `src/server/trpc/routers/search.ts`):** `knn`, `find`, `discover` (segment pool → group by character → ranked; the killer feature) in `src/server/domain/search/core.ts`; `digests`, `segments`, `corpus` (hybrid pool of both substrates, CSLS-ranked, cross-encoder reranked, block-deduped) in `src/server/domain/search/memory.ts`.
- **Tags:** `src/db/schema/tags.ts` — `tags` has `source: "manual"|"auto"` (already anticipates auto-tagging) + typed junction tables.
- **Summarizer (generative):** `src/server/embeddings/summarizer.ts` — `summarize(system,user,opts)`, local GGUF (GBNF-grammar JSON) + Haiku fallback. Used by `generateDigests` with `DIGEST_SCHEMA`.
- **Vector schema:** `src/db/schema/search.ts` (native F32_BLOB + `libsql_vector_idx`, `hubScore real`, `topicAnchor`, `keywords` json).
- **Reference ports (use these — don't re-derive):** `references/card-curator/src/card_curator/server.py:925-987` (`find_duplicates`, threshold 0.92), `index.py:62-89` (hub scores), `analyze.py:36-46` (compare schema) + `:135-146` (genre classify); `references/st-bridge/src/st_bridge/embeddings.py:179-220` (CSLS-corrected `find_duplicates`).

## B.2 The data-model constraint that reframes "co-occurrence"
**A chat has exactly ONE character** — `chats.characterVersionId` is a singular non-null FK (`src/db/schema/chats.ts`); there is NO group-chat junction. Literal character×character co-presence is **not representable**. So co-occurrence means: **keyword×keyword** (within `chat_digests.keywords`), **theme co-membership**, **character×theme/keyword profiles**, and a **character similarity graph** (kNN edges via cosine), NOT co-presence.

## B.3 Pillar A — Co-occurrence — **effort S (pure SQL/JS, no GPU)**
Unit: keyword×keyword within `chat_digests.keywords` (each digest has 4–20 scene tokens). Pair co-occurs when both appear in a digest's `keywords[]`; strength = count across digests.
**New tables** (additive migration): `keyword_cooccurrence(id, owner_id, keyword_a, keyword_b, count, character_ids json, computed_at, UNIQUE(owner,a,b))` + indexes on (owner,a)/(owner,b); `character_keyword_profiles(id, owner_id, character_id→cascade, keyword, count, computed_at, UNIQUE(owner,char,kw))`.
**Precompute** `scripts/compute-cooccurrence.ts`: load digests (join → characterId), normalize keywords (lowercase/trim; fold leading the/a/an + trailing punct; **filter <4 chars and any keyword in >50% of an owner's digests** = hub token, mirror CSLS logic), accumulate pair counts (O(k²)/digest, k≤20), upsert, truncate to top-N (~10k) pairs/owner. *Optional quality pass:* embed the ~few-hundred unique keywords (one batch, ~100ms GPU) and merge near-dups by cosine >0.95 before counting.
**tRPC `analytics` router:** `topKeywords(limit,minCount)`, `cooccurringKeywords(keyword,limit)`, `characterKeywords(characterId,limit)`.

## B.4 Pillar B — Theme analysis — **effort M**
Unit: cluster the ~2,500 tier-0 digest embeddings into themes. **k-means** in **pure TS over Float32Arrays** (same pattern as `computeGroupHubs`; ~1s at 2,500×1024×k=30×50 iters; k-means++ init). HDBSCAN is not portable — skip. Community detection (Louvain on a kNN graph) is a stretch.
**Naming:** per cluster, take the 5 centroid-nearest digests' `topicAnchor` strings → `summarizer.summarize` with a `THEME_NAMING_SCHEMA {theme_name, sub_themes[], description}` (port `analyze.py:classify_genre`). ~30–40 one-time LLM calls.
**New tables:** `theme_clusters(id, owner_id, model, cluster_idx, theme_name, sub_themes json, description, centroid F32_BLOB(1024), member_count, computed_at, UNIQUE(owner,model,cluster_idx))` — centroids are few (~30), query by **loading direct**, no ANN index needed; `digest_theme_assignments(digest_id→cascade PK, cluster_idx, owner_id, distance, computed_at)` + index (owner,cluster_idx).
**Precompute** `scripts/compute-themes.ts` (`--k` CLI + emit inertia/silhouette for elbow): load digests → k-means → name clusters → upsert. Tag `model`; re-run on embedder swap or after `memory:backfill`.
**tRPC:** `themes()`, `themeTimeline(clusterId,bucketDays?)`, `characterThemeProfile(characterId)`, `themeCharacters(clusterId,limit)`.
**DECIDED — build it in this track (locked in):** add a **`msgMidAt integer`** column to `chat_digests` (epoch-ms UTC = the midpoint message time of the block's `seqStart..seqEnd`, via `shared/time.ts`), populated by `generateDigests`, and **backfill existing digests** (extend `scripts/memory-backfill.ts` or a one-off join to `messages`). This is the *story*-time axis the theme timeline buckets on — `chat_digests.createdAt` is *compute* time (a backfill burst) and is wrong for timelines. Additive migration on `chat_digests`; ship it as part of the themes schema step (B.8 step 6).

## B.5 Pillar C — Duplicate / near-duplicate detection — **effort S (80% built)**
- **Characters:** new `src/server/domain/corpus/duplicates.ts` `findDuplicateCharacters({threshold=0.92})` — port `server.py:926-987` + `st-bridge embeddings.py:179-220`. Reuse `computeGroupHubs`'s load+normalize+matmul; emit pairs with **CSLS-adjusted** cosine ≥ threshold, deduped (a,b)/(b,a), sorted desc. 310² trivial.
- **Chats:** load `chat_segments` grouped by chatId → per-chat centroid (mean of segment vectors) → pairwise cosine ≥ threshold. **Filter to chats with messageCount>20** (short-chat centroids = false positives).
- **Import-time (live):** on new card import, embed → `vector_top_k('character_embeddings_ann', vec, 5)` + CSLS → if top ≥0.92, surface "similar to X (0.94)" warning before write. Sub-second, uses existing ANN index. (corpus-import.md deferred `#47`.)
**New table:** `duplicate_pairs(id, owner_id, entity_type 'character'|'chat', entity_id_a, entity_id_b, similarity, model, computed_at, UNIQUE(owner,type,a,b))` + indexes.
**Precompute** `scripts/find-duplicates.ts` (like `csls`). **tRPC:** `duplicateCharacters(threshold?)`, `duplicateChats(threshold?)`, `similarCards(characterId,limit?)` (port `server.py:663`).

## B.6 Cool-shit breadth
- **Character similarity graph** (CORE): a low-threshold (~0.65) `duplicate_pairs` sweep → nodes+edges → force-directed client view; edge click → LLM "compare these two" (`analyze.py:compare_cards`). `analytics.similarityGraph(minSimilarity,maxNodes?)`.
- **"More like this"** (CORE): `analytics.similarChats(chatId,limit?)` via chat-centroid kNN / existing `corpus()` with a digest-text query.
- **Per-character profile** (CORE): pure SQL aggregate (chat_count, total_messages, tokens, first/last, digest_count) + theme profile + top keywords + existing `refineryScore`/`refineryAnalysis` columns (`characters.ts`). `analytics.characterProfile(characterId)`.
- **Corpus dashboard** (CORE): pure SQL — totals, per-model usage (`messages.model`), activity timeline (`messages.createdAt`), top characters, tag distribution. `analytics.corpusStats()`.
- **Forgotten gems** (STRETCH): high `totalTokensOut` + old `updatedAt` + distinctive themes → revisit score. `analytics.forgottenGems(limit?)`.
- **Tag auto-suggestion** (STRETCH): top themes per character → candidate `{name, source:'auto'}` tags (the `tags.source='auto'` column exists for this). User confirms.
- **LLM card comparison** (STRETCH): port `analyze.py:compare_cards` + `COMPARISON_SCHEMA`.

## B.7 Compute constraints (load-bearing) — why all-pairs analytics LOAD vectors, not use the ANN
The ANN (`libsql_vector_idx` + `vector_top_k`) is for RETRIEVAL (one query → ~k nearest) and we DO use
it there (`knn`/`discover`/`corpus`/images). For ALL-PAIRS analytics (hubness/CSLS, dedup, k-means) it's
the wrong tool — for three reasons, the first two **measured on the live DB (296 char vectors)**:
- **(1) Hard ~200 result cap.** `vector_top_k(k)` returns at most ~200 rows regardless of `k` —
  measured: k=296→201, k=500→200, k=1000→200 on a 296-row table. You literally cannot enumerate every
  neighbor through the index. Dedup needs ALL pairs ≥ threshold; hubness needs each row's full top-K →
  the cap makes that impossible. (It's the DiskANN search-list default — a build-time param, ~200 by
  default; raising it is a rabbit hole.) `DISCOVER_SEGMENT_POOL_CAP=400` (`search/constants.ts`) is the
  app's tuning knob that lives WITH this cap, NOT the root cause.
- **(2) WHERE filters apply AFTER the k nearest are chosen** (Turso AI&Embeddings docs + the
  JOIN-then-WHERE pattern at `search/core.ts:47`). Same-type / same-owner scoping bleeds results inside
  the ~200 budget — the "minority-type" bug `hubness.ts` documents (a hub card surrounded by its own
  segments exhausts the budget before other types/owners surface).
- **(3) All-pairs = N separate top-k queries.** Measured: 296 per-row ANN queries = 1464ms vs ONE exact
  in-process matmul = 38ms (~38× faster) AND complete. `hubness.ts` already does the exact matmul.
- **NOT the reason: approximation.** Measured ANN recall@10 vs exact = **100%** at this scale — the
  index is accurate here. The reasons are the cap + the all-pairs shape, full stop.
- **Crossover:** exact O(n²) is 38ms at 296 rows but scales quadratically; the **segment-level** pass
  (`csls.ts`) bites (~minutes) at ~10k+ segments → THERE flip to ANN-approx top-K (accepting the ~200
  cap + approximation). Character/chat dedup + graph passes stay bounded well below that.
- **Model-tag every rollup** (`theme_clusters.model`, `duplicate_pairs.model`) and stale-check at run vs `character_embeddings.model`/`chat_digests.model` — an embedder swap invalidates them.

## B.8 Sequencing (B)
1. **Dedup characters+chats** (`duplicates.ts` + `duplicate_pairs` + `scripts/find-duplicates.ts`) — S, biggest payoff, mostly built.
2. **Semantic dedup on import** — S.
3. **Co-occurrence** (tables + `scripts/compute-cooccurrence.ts` + endpoints) — S.
4. **Corpus stats + character profile** — S (pure SQL).
5. **Similarity graph + similar-cards** — S (lower-threshold sweep).
6. **Themes** (schema incl. `msgMidAt`, `scripts/compute-themes.ts` k-means, naming, endpoints) — M; requires `pnpm memory:backfill` first.
7. **Tag auto-suggest, forgotten gems, card-comparison** — stretch.
Each step = precompute script → rollup table → tRPC → (later) UI; independently shippable. Endpoints are ready before the UI (`docs/planning/ui-direction.md` Corpus/Analytics panel). Total: pillars+core breadth ~3–4 wk; stretch +1–2 wk.

## B.9 Risks / open questions
Keyword normalization depth (cheap regex vs embed-merge). Chat-centroid validity for short chats (filter >20 msgs). Keyword data quality (filter hub tokens). Choosing k (elbow/silhouette, expose `--k`). Theme-naming quality depends on `topicAnchor` distinctiveness (it's well-prompted in `memory/constants.ts TIER0_SYSTEM`). The `msgMidAt` gap (B.4) is the one real schema add.

---

# Track C — Type-safety (eliminate the real escape hatches)

> **✅ STATUS — DONE (2026-05-30).** All ~14 real holes (Groups A–J) + the breadth-rigor items
> (`OpenRouterProviderRouting`, `MacroEnv`, `satisfies` on `TurnRouting`) are shipped to `main`,
> each its own green-`pnpm check` commit. Branded IDs (C.3) shipped earlier the same day; an
> `avatarAssetId → AssetId` branding follow-up landed in this pass. The as-built notes, the
> deviations from this spec, and what was deliberately skipped are in **§C.6 (As-built)** at the
> bottom — read that, not the per-group `file:line`s above (accurate at authoring time, since drifted).

## C.1 The split
47 escapes inventoried. **~14 are real holes; the rest are correct SDK-boundary patterns — KEEP them** (chasing SDK type-churn is a treadmill). Keep-list with justification in C.5.

## C.2 Real holes + fixes (grouped)
**Group A — Settings KV (`z.any()`):** `src/server/trpc/routers/settings.ts:26` `setGlobalSetting`. Fix: a discriminated-union registry keyed by setting name —
```ts
// src/shared/settings-registry.ts (new)
export const globalSettingSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("app_settings"), value: appSettingsSchema }),
  // future keys here, each with its value schema
]);
```
Type `SettingsService.setGlobalSetting`'s value per-key.

**Group B — Metadata blobs (`z.any()`):** `world-info.ts:65,82`, `persona.ts:8`. Fix: `z.record(z.string(), z.unknown()).nullable().optional()` (constrains to a JSON object). Align `CreatePersonaInput.metadata` (`persona/types.ts`) to `Record<string,unknown> | null` — this also kills the persona casts (#6,#7) because the inferred type now matches.

**Group C — Post-Zod casts:** `character.ts:37,45` `as Create/UpdateCharacterInput`, `persona.ts:24,32`. Root cause: Zod-inferred type ≠ hand-written domain interface (optional-vs-null under `exactOptionalPropertyTypes`). Fix: **derive the domain input type FROM the schema** — move the schema to `*/types.ts`, `export type CreateCharacterInput = z.infer<typeof createCharacterSchema>`. Cast disappears.

**Group D — Non-null assertions:** `settings/service.ts:88` `rows[0]!` → guard-and-throw. `custom-types.ts:18` `value[i]!` is provably in-bounds — keep (or `?? 0`).

**Group E — Drizzle JSON-column casts:** `store.ts:90`, `character/service.ts:78,82` (`greetings`/`tags`), `world-info/service.ts:94,115` (`legacyKeys`), `memory/db.ts:34` (`keywords`). Fix: per-column Zod parsers at the read boundary — new `src/db/schema/parsers.ts` (`greetingsSchema = z.array(z.string()).nullable().catch(null)`, etc.); `store.ts` entry stays `z.custom<SessionStoreEntry>()` (see keep-list).

**Group F — Lift-chain casts:** `prompt-config.ts:115`, `user-settings.ts:66` — already guarded; add an `isPlainObject` guard helper to drop the cast.

**Group G — Import casts:** `import/chat.ts:191,208,243,254` `asObj(x) as RawFoo` → `asTyped<T>(v, zodSchema)` helper returning `T|null`; translate the `RawXxx` interfaces to Zod.

**Group H — OIDC env casts:** `auth-oidc.ts:77-79` `env.* as string`. Fix: `assertOidcEnv(env): asserts e is ... & OidcEnv` called before `oidcRoutes`; narrows the 3 casts away.

**Group I — debug ctx:** `app.ts:61` `ctx as any` → build a properly-typed `MacroContext` stub.

**Group J — generic fetch:** `_shared/helpers.ts:30` `result[0] as TRow` → use Drizzle `typeof table.$inferSelect` inference (drop the `TRow` generic).

**Group K — HF tensor casts:** `embedder.ts`/`reranker.ts`/`image-embedder.ts` (#33-38) + `hubness.ts:88,93,103` — loose `@huggingface/transformers` Tensor types + `noUncheckedIndexedAccess` hot loops. Convert to `number[]` once at the boundary / `?? 0` in loops. Low priority.

## C.3 Breadth rigor
- **Branded IDs — ✅ SHIPPED (2026-05-30).** 10 commits, each its own green `pnpm check`. A
  `chatId` can no longer be passed where a `characterId` is expected, end-to-end (db row → domain →
  tRPC → client via `AppRouter` inference). **The how, the two false starts, and the test handling
  are recorded below — they're the reusable lesson, not just trivia.**

  **What landed:**
  - `src/shared/ids.ts` (NOT `domain/_shared` as originally sketched — it must live in `shared` so the
    brand flows through db columns → domain → tRPC → client): `Branded<B>` phantom type (zero runtime
    cost), one branded type per entity (`UserId`/`ChatId`/`MessageId`/`CharacterId`/`CharacterVersionId`/
    `PersonaId`/`PresetId`/`PresetVersionId`/`WorldBookId`/`WorldEntryId`/`TagId`/`AssetId`/`SessionId`),
    `castId<T>(raw)` for untyped seams, `brandedId<T>()` Zod helper for tRPC inputs.
  - `newId<T extends string>()` made generic in **both** id modules — `db/schema/ids.ts` AND
    `domain/_shared/ids.ts` (the domain one is what services actually mint through; missing it was the
    first bug). `newId<ChatId>()` tags the mint at the source.
  - Per-entity clusters: Persona, Tag, World(Book/Entry), Asset, Session, Character(+Version),
    Preset(+Version), Chat(+Message), User — branded through service signatures, `*View`/`*Detail` id
    fields, error constructors, and tRPC inputs.

  - **❌ FALSE START 1 — branding the Drizzle COLUMN (`id: text("id").$type<ChatId>()`).** This
    detonates across the whole codebase: every `eq(table.id, someString)` and every `insert({id})` in
    *any* feature that touches that table then demands the brand. ~20+ errors from one column. **Do
    NOT brand columns.** The spec said "domain signatures take `ChatId`" — it never said columns; that
    was my over-reach. Reset hard, started over.
  - **✅ THE PATTERN THAT WORKS — brand the TYPES THAT FLOW THROUGH CODE, leave columns plain `text`.**
    A `Branded<T>` *is* a `string` at runtime and structurally, so `eq(col, brandedId)` and
    `insert({ id: brandedId })` just work — **zero blast radius.** Touch only: (1) the view/param
    *types* (`MessageView.id`, `*Params.chatId`), (2) `castId<T>()` at the row→view construction seam
    (covariant returns need it), (3) tRPC inputs via `brandedId<T>()`, (4) `newId<T>()` at mints.
  - **The contravariance lever (what made the effort-L chat cluster tractable):** a function whose
    *implementation* keeps `chatId: string` still satisfies an interface that declares `chatId: ChatId`
    (params are contravariant — a `string`-accepting fn accepts a `ChatId`). So internal helpers
    (`loadOwnedChat`, `versionPinned`, the dozens of `ownerId: string` domain params) **need no
    change** — only the public interface + the value-producing seams. Branding `types.ts` alone gave 0
    production errors after just the 3 view-casts + 2 mints + router inputs.
  - **`UserId` was the EASIEST, not the hardest, despite being the most pervasive** (`ownerId` on every
    owned table, `ensureUser` at ~19 sites). Brand the *produce* side (`ensureUser`/`requireAdmin`/
    `provisionIdentity` returns → `UserId`) and all ~19 `const ownerId = await ensureUser()` sites infer
    `UserId` for free; the internal `ownerId: string` params accept them unchanged (assignability). Then
    brand only the caller-chosen `userId` *inputs* (admin/sessions/router) — that's where a wrong-id
    swap is a real bug.

  - **Tests (the bulk of the churn) — fixed at the SOURCE, not per-call-site.** Branding
    `tests/support/db.ts` `seedChatRow`/`seedCharacter` return types (`chatId: ChatId`,
    `characterVersionId: CharacterVersionId`, `ownerId: UserId`, via `castId` on the internal strings)
    auto-fixed ~60 of ~75 test errors for free — every `const { chatId } = await seedChatRow(db)` site
    became branded. The residual ~15 were hardcoded string literals in direct-insert tests
    (`chatId: "ch1"`): fixed with a per-file `const CH1 = castId<ChatId>("ch1")` (greppable, explicit) +
    `castId<MessageId>("")` on the `?? ""` id fallbacks. Direct `db.insert({ id: "ch1" })` literals stay
    plain strings (a column is `text` — no brand needed).

  - **DEFERRED (deliberate skip, low value):** corpus/internal ids — `CharacterEmbeddingId`,
    `ChatDigestId`, `ChatSegmentId`, `ChatEventId`, `UserCredentialId`. These are write-internal and
    essentially never cross a public id-typed signature where a wrong-id swap could happen, so branding
    them is churn for near-zero safety gain. The brand *types* exist in `shared/ids.ts` if a future
    surface ever needs them.
- **Schema-as-single-source-of-truth** for all JSON blobs (follow `presetVersions.config`→`parsePromptConfig` model): `worldEntries.metadata`, `chats.metadata` (→ typed `providerRouting`), `messages.toolCalls/rawRequest/rawResponse`.
- **`OpenRouterProviderRouting`** interface + Zod (replaces 6 `Record<string,unknown>` sites across `providers/openrouter/*` + `routing.ts`).
- **`MacroEnv`** typed bag instead of `env: Record<string,unknown>` (`shared/macro/types.ts`).
- **`satisfies`** on each `TurnRouting` branch in `routing.ts` (catches future api additions).

## C.4 Sequencing (C)
Mechanical first (all S unless noted): B (metadata schemas) → C (derive-from-Zod) → A (settings registry, M) → E (JSON parsers) → D (guard) → H (OIDC assert) → I (debug ctx) → G (asTyped, M) → breadth `OpenRouterProviderRouting` → F (lift guard) → J (helpers) → `MacroEnv` (M) → schema-SoT (M) → HF casts → `satisfies`. ~~**Then** branded IDs (L, do it deliberately when not mid-feature).~~ **Branded IDs ✅ DONE (2026-05-30) — shipped first, ahead of the mechanical items, on a quiet tree; see C.3.** The rest of C.2/C.3 mechanical cleanup is still open.

## C.5 KEEP (justified — do NOT "fix")
Agent-SDK `SessionStoreEntry` casts (`seed.ts:67,84`, `store.ts:90`) — opaque SDK type, empirically validated (`scripts/seed-probe.ts`). Drizzle `prepare()` `WeakMap<Db,any>` (`context/queries.ts:49,131,172`) — unstable generic. OpenRouter SDK `*View` projections (`chat-completions.ts`, `responses.ts`, `catalog.ts`, `account.ts`) — the local `*View` interfaces ARE the typed projection over an unstable v0.x SDK. PRAGMA rows `Record<string,unknown>` (`debug/service.ts:113`). Undocumented `rate_limit_info` fields guard-and-cast (`claude-sdk/api.ts:232`). ST `RawCard` permissive projection (`import/card.ts`). Standard jose `JWTPayload` narrowing (`trust-header.ts:149`). Test fixtures. `scripts/` and `.tsx` are clean.

## C.6 As-built (2026-05-30) — what shipped, deviations, and what was skipped

All of Track C landed on `main` in one session, one logical commit per group, each gated green by
`pnpm check`. The work matched the spec's *intent* but the *details drifted* from C.2's `file:line`s
(the spec was accurate at authoring time; code moved). Notes that matter for the next reader:

**Per-group as-built:**
- **B (metadata blobs)** — `z.record(z.string(), z.unknown()).nullable().optional()` on world-info
  entry metadata + persona metadata. As specced.
- **C (derive from Zod)** — `createCharacterSchema`/`createPersonaSchema` now live in each domain's
  `types.ts`; the input types are `z.infer` of them; the routers import the schema (not a hand type)
  and the four `input as …Input` casts are gone. As specced.
- **E (JSON `string[]` parsers)** — landed as **`src/db/parsers.ts`** (not `src/db/schema/parsers.ts`
  as the spec wrote) with a single `parseStringArray` (`.catch(null)`), wired into greetings/tags,
  legacyKeys (×2 — `getEntry` AND `listEntries`, which the spec's line list missed), and memory
  `keywords` (preserving its `[] ` default via `?? []`). The real cast was `as string[] | null`, not
  the spec's `as string[]`.
- **D (non-null `!`)** — `getGlobalSetting`/`setGlobalSetting` bind-and-guard; the float32 `toDriver`
  loop uses `?? 0`. Note the real `!` was at `custom-types.ts` line ~18 in **`src/db/schema/`**, not
  `src/server/db/` — and there were two (`toDriver` + a `setFloat32`), both fixed.
- **A (settings KV)** — **DEVIATION:** built the lenient `JsonValue` schema (`src/shared/json.ts`),
  NOT the spec's `discriminatedUnion("key")` registry. Rationale: the only production key is
  `app_settings`, which already has its own typed `getAppSettings`/`updateAppSettings` pair; the
  generic `get/setGlobalSetting` endpoints are test-only. A per-key registry would over-fit and break
  the arbitrary-key tests. Closing `z.any()` → `JsonValue` is the real win; the registry (or retiring
  the generic endpoints) is left as a separate call.
- **F (lift-chain)** — `isPlainObject` lives in **`src/shared/guards.ts`** (new), used in both lift
  chains. As specced.
- **G (import casts)** — the real file was the card-curator-derived `import/chat.ts` with
  `RawHeader`/`RawExtra`/`RawSwipeInfo`/`RawMessage` + an `asObj` helper, NOT the generic
  `RawChatMeta`/`RawMessage` the spec sketched. Converted the four Raw views to lenient
  `.passthrough()` Zod schemas + an `asTyped(v, schema)` helper; `asObj` stays for one legitimate
  inline `chat_metadata` narrowing.
- **H (OIDC env)** — `assertOidcEnv()` returns the three narrowed strings (issuer/clientId/secret);
  the `as string` casts in `getConfig` are gone. As specced.
- **I (debug ctx)** — `app.ts` builds a real `MacroContext` (required `char/user/persona/scenario`
  default to `""`, `env` to `{}`) instead of `ctx as any`. The cast was in `app.ts`'s
  `registerDomainDebugRoutes`, not the spec's `app.ts:61` exactly, but same thing.
- **J (fetchOwned)** — `fetchOwned<T extends OwnedTable>` returns `T["$inferSelect"] | undefined`;
  the two call sites drop their explicit generic. As specced.

**Breadth rigor:**
- **`OpenRouterProviderRouting`** — `src/shared/provider-routing.ts` (lenient `.passthrough()` Zod +
  `parseProviderRouting`). Replaced **4** real `Record<string,unknown>` sites (routing.ts ×2,
  openrouter/shared.ts, openrouter/caching.ts in+out), not the spec's "6" — the count included
  comments/duplicates. The schema's snake_case wire keys needed adding `src/shared/provider-routing.ts`
  to the providers `useNamingConvention`-off biome override (same rationale as the rest of providers/**).
- **`MacroEnv`** + **`satisfies TurnRouting`** — both done as specced.
- **avatarAssetId branding** — extra: the character + persona create/update schemas validate
  `avatarAssetId` via `brandedId<AssetId>()` and `PersonaDetail.avatarAssetId` is now `AssetId|null`.

**Deliberately SKIPPED (with reasons):**
- **Group K (HF tensor casts)** — NOT done, by design. Two sub-kinds, both keep-worthy: (1) the
  `embedder.ts`/`reranker.ts`/`image-embedder.ts` `tolist() as number[][]` / `.data as Float32Array`
  casts are genuine `@huggingface/transformers` SDK-boundary casts — exactly the C.5 "SDK-churn
  treadmill" the doc says to leave; the model fixes the runtime shape, so a guard buys zero safety.
  (2) `hubness.ts`'s `v[d] as number` casts are a **documented hot-loop perf choice** (the code comment
  explains `?? 0` would add a branch per dim per pair across 1024×N² iterations). Converting either is
  churn that makes the code worse. Left as keep-list.
- **schema-as-SoT** — mostly **moot, not skipped**: `messages.toolCalls/rawRequest/rawResponse` are
  **write-only provenance** — referenced only in the schema, never read back, so there's no read-cast
  to fix. `chats.metadata` is already parsed via `parseProviderRouting` (the only field consumed).
  `worldEntries.metadata` is already typed `Record<string,unknown>|null` from Group B. So the SoT item
  had almost no real surface left once A/B/E/#9 landed; revisit if/when those provenance blobs get read.

**Tooling note (landed alongside):** the test suite flooded ~77KB of pino logs per `pnpm check`
(pino writes to `process.stdout` via multistream, which `vitest --silent` does NOT catch). Fixed at
source: `LOG_LEVEL=silent` in the vitest server-project env + `--silent` on the check script, and the
husky pre-commit hook now only prints check output on FAILURE (full log at `.git/pre-commit.log`).

---

# Cross-track recommendation & open decisions

**Recommended order:** (1) Track A **security core** — self-contained, closes the only real quality
security gap, UI-independent. (2) Track B **dedup + co-occurrence** — fastest differentiator payoff
(dedup ~80% built, co-occurrence pure SQL). (3) Track C **mechanical cleanup** — interleave, low-risk
clean commits. (4) Track B **themes + breadth** — the bigger build (needs `msgMidAt` + backfill).
(5) ~~**Branded IDs** — once, deliberately.~~ ✅ DONE (2026-05-30, see C.3).

**Decided (owner sign-off):**
- **`msgMidAt` digest column** (Track B.4) — **LOCKED IN to the RAG track.** Add the column + populate
  in `generateDigests` + backfill, as part of the themes schema step (B.8 step 6). Not optional.
- **Branded IDs** (Track C.3) — ✅ **DONE (2026-05-30).** Shipped as its own 10-commit series on a quiet
  tree (the standalone-pass discipline held — no feature work tangled in). Full write-up incl. the two
  false starts, the contravariance lever, and the test-source fix is in C.3. Corpus/internal ids
  deliberately skipped (low value — C.3).

Effort totals (rough): Track A core ~1 wk; Track B pillars+core breadth ~3–4 wk (+1–2 stretch);
Track C mechanical ~2–3 days + branded IDs ~few days.
