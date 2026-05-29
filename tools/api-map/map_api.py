#!/usr/bin/env python3
"""Generate docs/api-map.md — a capability/domain + layer gap map of SillyTavern vs neo-tavern.

Uses tree-sitter (real JS + TS syntax trees) to walk:
  • ST backend routes      — `router.<method>('<path>', …)` across src/endpoints/** (mounted in server-startup.js)
  • neo tRPC procedures     — `<name>: <tier>Procedure…(query|mutation|subscription)` in trpc/routers/** + trpc/router.ts
  • neo Hono routes         — `app.<method>('/api/…')` in app.ts / auth-oidc.ts / import-http.ts

Then classifies everything by CAPABILITY DOMAIN with a curated SCOPE verdict (HAVE / WANT / OUT / NEO-ONLY),
maps ST onto neo's shared/server/client layers (ST has NO shared layer — that's the finding), and writes the report.

Heuristic, not a type-checker: dynamically-registered or deeply-nested routes may be missed. The point is the
domain-level gap picture, not a byte-perfect catalog.

Run:  uv run --project tools/api-map python tools/api-map/map_api.py   (or: pnpm api:map)
"""

from __future__ import annotations

import argparse
import json
import subprocess
from collections import defaultdict
from pathlib import Path

import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts
from tree_sitter import Language, Parser

ROOT = Path(__file__).resolve().parents[2]
ST = ROOT / "references" / "sillytavern"
JS = Language(tsjs.language())
TS = Language(tsts.language_typescript())

KIND_METHODS = {"query", "mutation", "subscription"}
HTTP_METHODS = {"get", "post", "put", "delete", "patch"}

# ── Capability domains + curated SCOPE verdicts (seeded from CLAUDE.md mission + "What NOT to build") ──
HAVE, WANT, OUT, NEO_ONLY = "✅ HAVE", "🎯 WANT", "🚫 OUT", "🟣 NEO-ONLY"
SCOPE: dict[str, tuple[str, str]] = {
    "chat": (HAVE, "send/swipe/edit/fork/branch/compaction — the full turn pipeline."),
    "groups": (WANT, "multi-character RP — a real ST capability we lack; sizable, not yet scoped."),
    "characters": (HAVE, "library + copy-on-write versioned editor; avatars via assets."),
    "world-info": (HAVE, "deliberately simpler than ST (scope-driven activation; no recursion/secondary keys)."),
    "personas": (HAVE, "first-class persona router; ST has no dedicated endpoint (lives in settings)."),
    "presets": (HAVE, "versioned prompt presets (PromptConfig blob)."),
    "rag": (NEO_ONLY, "corpus semantic search + analytics — the killer differentiator. ST 'vector' is per-chat retrieval only; ST 'search' is web search."),
    "auth": (HAVE, "BFF cookie + OIDC + per-user AES-GCM credentials + admin ladder. ST stores secrets PLAINTEXT — neo-stronger."),
    "assets": (HAVE, "content-addressed blob store by hash; ST splits into avatars/thumbnails/backgrounds/sprites."),
    "settings": (HAVE, "typed AppSettings/UserSettings; one dark theme, no switcher by design."),
    "tags": (HAVE, "first-class tag router + typed junction tables."),
    "import-export": (HAVE, "PNG card + JSONL chat import/export."),
    "providers": (HAVE, "narrow by design: Claude (Max-sub + OpenRouter skin) + the OpenRouter catalog/account. ST proxies ~25 providers — the rest is OUT."),
    "stats-analytics": (NEO_ONLY, "ST's chat-stats endpoint maps to neo's corpus analytics (planned/partly built) + the /_debug surface."),
    "meta": (HAVE, "health/echo utility."),
    "tokenizers": (OUT, "neo tokenizes internally (native tokenizer); not an endpoint."),
    "image-gen": (OUT, "no image-gen / Stable-Diffusion / caption / classify (slop guard)."),
    "tts": (OUT, "no TTS/STT (slop guard)."),
    "translate": (OUT, "no translation (slop guard)."),
    "ui-cosmetic": (OUT, "themes / backgrounds / sprites / moving-ui — one dark theme, no switcher (slop guard)."),
    "quick-replies": (OUT, "UI macro/quick-reply feature, not core."),
    "extensions": (OUT, "no third-party extension system (single-user; the whole point of avoiding ST's event bus)."),
    "content-mgr": (OUT, "ST default-content downloader."),
    "maintenance": (OUT, "ST file-maintenance / backups; SQLite + the DB-ops tooling handle this differently."),
    "web-search": (OUT, "ST web / YouTube / SearXNG search — not an RP/corpus feature."),
    "other": ("❓ ?", "unclassified — eyeball it."),
}
ORDER = {NEO_ONLY: 0, WANT: 1, HAVE: 2, "❓ ?": 3, OUT: 4}

# ST mount prefix (sub-path after /api/) → domain.
ST_PREFIX_DOMAIN = {
    "users": "auth", "secrets": "auth", "moving-ui": "ui-cosmetic", "themes": "ui-cosmetic",
    "backgrounds": "ui-cosmetic", "sprites": "ui-cosmetic", "images": "image-gen", "sd": "image-gen",
    "extra/classify": "image-gen", "extra/caption": "image-gen", "image-metadata": "image-gen",
    "quick-replies": "quick-replies", "avatars": "characters", "characters": "characters",
    "tokenizers": "tokenizers", "presets": "presets", "thumbnails": "assets", "assets": "assets",
    "files": "assets", "chats": "chat", "groups": "groups", "worldinfo": "world-info",
    "stats": "stats-analytics", "content": "content-mgr", "settings": "settings", "vector": "rag",
    "translate": "translate", "search": "web-search", "speech": "tts", "extensions": "extensions",
    "data-maid": "maintenance", "backups": "maintenance",
    # providers / backends
    "openai": "providers", "google": "providers", "anthropic": "providers", "novelai": "providers",
    "horde": "providers", "openrouter": "providers", "nanogpt": "providers", "azure": "providers",
    "volcengine": "providers", "minimax": "providers", "backends/text-completions": "providers",
    "backends/kobold": "providers", "backends/chat-completions": "providers",
}
# neo tRPC router-key → domain.
NEO_KEY_DOMAIN = {
    "character": "characters", "persona": "personas", "chat": "chat", "credentials": "auth",
    "preset": "presets", "corpus": "rag", "search": "rag", "settings": "settings", "tag": "tags",
    "userAdmin": "auth", "worldInfo": "world-info", "health": "meta", "echo": "meta",
    "models": "providers", "rawModels": "providers", "orCredits": "providers", "orActivity": "providers",
    "orProviders": "providers", "orEndpoints": "providers", "orGenerationCost": "providers",
}

# Curated shared-LAYER map: each neo src/shared concern → where ST keeps that logic (verified by inspection).
SHARED_MAP = [
    ("shared/macro/* (macro engine)", "client", "public/scripts/macros/macro-system.js + definitions/*",
     "ST runs macros CLIENT-side; neo centralizes them server-side in shared."),
    ("shared/prompt-assemble + prompt-config", "split", "public/script.js Generate() + src/prompt-converters.js",
     "ST splits prompt build across client + a server converter; neo has ONE shared assembler with a cache boundary."),
    ("shared/regex (script engine)", "client-ext", "public/scripts/extensions/regex/{index,engine}.js",
     "ST's regex scripts are a CLIENT EXTENSION; neo bakes the engine into shared + server _shared/regex."),
    ("shared/generation (params vocab)", "client", "public/scripts/*settings UI state",
     "ST generation knobs live in client settings; neo: one provider-agnostic shared vocab translated per runner."),
    ("shared/models (catalog)", "client", "public/scripts model constants",
     "client-side lists; neo: a shared static Claude catalog + the live OpenRouter catalog."),
    ("shared/time (epoch-ms, the only parser)", "none", "scattered inline Date handling",
     "ST has NO central time util; neo: shared/time.ts is the sole parser (epoch-ms UTC everywhere)."),
    ("shared/chat-types + Zod-derived types", "none", "implicit (untyped JS)",
     "ST has no shared type layer; neo derives TS types from Zod schemas as the single source of truth."),
]


# ── tree-sitter helpers (node-walking — stable across tree-sitter versions) ──
def walk(node):
    yield node
    for c in node.children:
        yield from walk(c)

def field(node, name):
    return node.child_by_field_name(name) if node else None

def txt(node) -> str:
    return node.text.decode("utf-8", "replace") if node is not None else ""

def first_string_arg(call) -> str | None:
    args = field(call, "arguments")
    for a in (args.children if args else []):
        if a.type == "string":
            frag = next((c for c in a.children if c.type == "string_fragment"), None)
            return txt(frag) if frag else ""
    return None

def is_member_call(call, prop_set, obj_name=None) -> str | None:
    """If `call` is `<obj>.<prop>(…)` with prop ∈ prop_set (and obj==obj_name if given), return prop."""
    if call.type != "call_expression":
        return None
    fn = field(call, "function")
    if not fn or fn.type != "member_expression":
        return None
    prop = txt(field(fn, "property"))
    if prop not in prop_set:
        return None
    if obj_name is not None and txt(field(fn, "object")) != obj_name:
        return None
    return prop

def is_t_router_call(node) -> bool:
    return is_member_call(node, {"router"}) is not None

def router_object_arg(call):
    args = field(call, "arguments")
    return next((c for c in (args.children if args else []) if c.type == "object"), None)

def object_pairs(obj):
    return [c for c in (obj.children if obj else []) if c.type == "pair"]

def chain_kind_tier(value) -> tuple[str | None, str | None]:
    """For `<tier>Procedure.input(x).mutation(...)` → (kind, tier). Walks the call/member chain."""
    props, base, cur = [], None, value
    while cur is not None:
        if cur.type == "call_expression":
            cur = field(cur, "function")
        elif cur.type == "member_expression":
            props.append(txt(field(cur, "property")))
            cur = field(cur, "object")
        elif cur.type == "identifier":
            base = txt(cur)
            break
        else:
            break
    kind = next((p for p in props if p in KIND_METHODS), None)
    return kind, base


# ── Parsers ──
def parse_st_routes() -> list[dict]:
    startup = (ST / "src" / "server-startup.js").read_text(encoding="utf-8", errors="replace")
    tree = Parser(JS).parse(startup.encode())
    var2file: dict[str, str] = {}
    mounts: list[tuple[str, str]] = []
    for n in walk(tree.root_node):
        # import { router as VAR } from './endpoints/FILE.js'
        if n.type == "import_statement":
            src = txt(field(n, "source")).strip("'\"")
            if "./endpoints/" not in src:
                continue
            file = src.split("./endpoints/")[1].removesuffix(".js")
            for alias in walk(n):
                if alias.type == "import_specifier":
                    name = field(alias, "name"); aliased = field(alias, "alias")
                    if txt(name) == "router" and aliased:
                        var2file[txt(aliased)] = file
        # app.use('/api/PREFIX', VAR)
        if is_member_call(n, {"use"}, "app"):
            args = field(n, "arguments")
            kids = [c for c in (args.children if args else []) if c.type not in ("(", ")", ",")]
            if len(kids) >= 2 and kids[0].type == "string":
                frag = next((c for c in kids[0].children if c.type == "string_fragment"), None)
                prefix = txt(frag) if frag else ""
                if prefix.startswith("/api/") and kids[1].type == "identifier":
                    mounts.append((prefix, txt(kids[1])))

    routes: list[dict] = []
    for prefix, var in mounts:
        file = var2file.get(var)
        if not file:
            continue
        fp = ST / "src" / "endpoints" / (file + ".js")
        if not fp.exists():
            continue
        ftree = Parser(JS).parse(fp.read_bytes())
        sub = prefix[len("/api/"):]
        domain = ST_PREFIX_DOMAIN.get(sub, "other")
        for n in walk(ftree.root_node):
            method = is_member_call(n, HTTP_METHODS, "router")
            if not method:
                continue
            path = first_string_arg(n)
            if path is None:
                continue
            full = prefix.rstrip("/") + ("" if path == "/" else path if path.startswith("/") else "/" + path)
            routes.append({"method": method.upper(), "path": full, "file": file + ".js", "domain": domain})
    return routes


def parse_neo() -> tuple[list[dict], list[dict]]:
    """Returns (trpc_procedures, hono_routes)."""
    # router.ts: appRouter object → var→key (sub-routers) + inline top-level procedures.
    rsrc = (ROOT / "src/server/trpc/router.ts").read_bytes()
    rtree = Parser(TS).parse(rsrc)
    var2key: dict[str, str] = {}
    procs: list[dict] = []
    for n in walk(rtree.root_node):
        if not is_t_router_call(n):
            continue
        for pair in object_pairs(router_object_arg(n)):
            key = txt(field(pair, "key")); val = field(pair, "value")
            if val is None:
                continue
            if val.type == "identifier" and txt(val).endswith("Router"):
                var2key[txt(val)] = key
            else:
                kind, tier = chain_kind_tier(val)
                if tier and tier.endswith("Procedure"):
                    procs.append({"path": key, "kind": kind, "tier": tier.replace("Procedure", ""),
                                  "file": "trpc/router.ts", "domain": NEO_KEY_DOMAIN.get(key, "other")})
        break  # only the top appRouter

    for fp in sorted((ROOT / "src/server/trpc/routers").glob("*.ts")):
        ftree = Parser(TS).parse(fp.read_bytes())
        for n in walk(ftree.root_node):
            if n.type != "variable_declarator":
                continue
            val = field(n, "value")
            if not (val and is_t_router_call(val)):
                continue
            name = txt(field(n, "name"))
            key = var2key.get(name, name.replace("Router", ""))
            domain = NEO_KEY_DOMAIN.get(key, "other")
            for pair in object_pairs(router_object_arg(val)):
                pname = txt(field(pair, "key")); pval = field(pair, "value")
                kind, tier = chain_kind_tier(pval) if pval else (None, None)
                if tier and tier.endswith("Procedure"):
                    procs.append({"path": f"{key}.{pname}", "kind": kind, "tier": tier.replace("Procedure", ""),
                                  "file": fp.name, "domain": domain})

    # Hono routes.
    hono: list[dict] = []
    for rel in ["src/server/app.ts", "src/server/auth-oidc.ts", "src/server/import-http.ts"]:
        htree = Parser(TS).parse((ROOT / rel).read_bytes())
        for n in walk(htree.root_node):
            method = is_member_call(n, HTTP_METHODS, "app")
            if not method:
                continue
            path = first_string_arg(n)
            if path is None or not path.startswith("/api"):
                continue
            seg = path.split("/")[2] if len(path.split("/")) > 2 else ""
            domain = {"auth": "auth", "assets": "assets", "blob": "assets", "export": "import-export",
                      "import": "import-export", "healthz": "meta"}.get(seg, "other")
            hono.append({"method": method.upper(), "path": path, "file": rel.split("/")[-1], "domain": domain})
    return procs, hono


def loc(paths) -> tuple[int, int]:
    files = list(paths)
    total = 0
    for p in files:
        try:
            total += sum(1 for _ in p.open("rb"))
        except OSError:
            pass
    return len(files), total


def parse_layers() -> dict:
    neo_shared = loc((ROOT / "src/shared").rglob("*.ts"))
    neo_server = loc(p for p in (ROOT / "src/server").rglob("*.ts"))
    neo_client = loc(p for ext in ("*.ts", "*.tsx") for p in (ROOT / "src/client").rglob(ext))
    st_server = loc((ST / "src").rglob("*.js"))
    st_client = loc((ST / "public/scripts").rglob("*.js"))
    # ST frontend by top-level subdir under public/scripts.
    st_fe = defaultdict(lambda: [0, 0])
    for p in (ST / "public/scripts").rglob("*.js"):
        rel = p.relative_to(ST / "public/scripts")
        area = rel.parts[0] if len(rel.parts) > 1 else "(root)"
        st_fe[area][0] += 1
        try:
            st_fe[area][1] += sum(1 for _ in p.open("rb"))
        except OSError:
            pass
    return {"neo_shared": neo_shared, "neo_server": neo_server, "neo_client": neo_client,
            "st_server": st_server, "st_client": st_client, "st_fe": dict(st_fe)}


# ── Render ──
def render(st_routes, neo_procs, neo_hono, layers, date) -> str:
    st_by_dom = defaultdict(list)
    for r in st_routes:
        st_by_dom[r["domain"]].append(r)
    neo_by_dom = defaultdict(list)
    for p in neo_procs:
        neo_by_dom[p["domain"]].append(p)
    for h in neo_hono:
        neo_by_dom[h["domain"]].append(h)
    domains = sorted(set(st_by_dom) | set(neo_by_dom),
                     key=lambda d: (ORDER.get(SCOPE.get(d, ("❓ ?", ""))[0], 9), d))

    def st_sample(d):
        items = sorted(f"{r['method']} {r['path']}" for r in st_by_dom.get(d, []))
        return items
    def neo_sample(d):
        out = []
        for p in neo_by_dom.get(d, []):
            out.append(f"{p['path']} ({p['kind']})" if "kind" in p else f"{p['method']} {p['path']}")
        return sorted(out)

    L = []
    A = L.append
    A("# API & layer map — SillyTavern vs neo-tavern\n")
    A(f"> **Generated** by `tools/api-map/map_api.py` (tree-sitter AST). Regenerate: `pnpm api:map`. "
      f"Snapshot: {date}.\n>\n"
      "> Heuristic surface map (not a type-checker): dynamically-registered / deeply-nested routes may be "
      "missed. The point is the **domain-level gap**, NOT route parity. **We are NOT chasing ST's route count** "
      "— the 🚫 OUT list is deliberate (CLAUDE.md slop guard).\n")

    A("## Summary\n")
    A(f"- **SillyTavern:** {len(st_routes)} REST routes across {len({r['file'] for r in st_routes})} endpoint files.")
    A(f"- **neo-tavern:** {len(neo_procs)} tRPC procedures + {len(neo_hono)} Hono routes.")
    A(f"- **Layers (files / LOC):** "
      f"ST → server {layers['st_server'][0]}/{layers['st_server'][1]:,}, client {layers['st_client'][0]}/{layers['st_client'][1]:,}, **shared 0/0**.  "
      f"neo → shared {layers['neo_shared'][0]}/{layers['neo_shared'][1]:,}, server {layers['neo_server'][0]}/{layers['neo_server'][1]:,}, client {layers['neo_client'][0]}/{layers['neo_client'][1]:,}.")
    A("")

    A("## Capability domains (scope-tagged)\n")
    A("| Domain | Scope | ST routes | neo surface | Note |")
    A("|---|---|--:|--:|---|")
    for d in domains:
        verdict, note = SCOPE.get(d, ("❓ ?", ""))
        A(f"| **{d}** | {verdict} | {len(st_by_dom.get(d, []))} | {len(neo_by_dom.get(d, []))} | {note} |")
    A("")

    A("## Per-domain detail\n")
    for d in domains:
        verdict, note = SCOPE.get(d, ("❓ ?", ""))
        A(f"### {d} — {verdict}")
        A(f"_{note}_\n")
        sts, neos = st_sample(d), neo_sample(d)
        A(f"- **ST ({len(sts)}):** " + (", ".join(f"`{s}`" for s in sts[:6]) + (" …" if len(sts) > 6 else "") if sts else "_none_"))
        A(f"- **neo ({len(neos)}):** " + (", ".join(f"`{s}`" for s in neos[:6]) + (" …" if len(neos) > 6 else "") if neos else "_none_"))
        A("")

    def rollup(verdict):
        return [d for d in domains if SCOPE.get(d, ("", ""))[0] == verdict]
    A("## 🎯 Gap to build (WANT)\n")
    A("\n".join(f"- **{d}** — {SCOPE[d][1]}" for d in rollup(WANT)) or "_none_")
    A("\n## 🟣 neo-only differentiators\n")
    A("\n".join(f"- **{d}** — {SCOPE[d][1]}" for d in rollup(NEO_ONLY)) or "_none_")
    A("\n## 🚫 Deliberately out of scope (anti-slop — do NOT build)\n")
    A("\n".join(f"- **{d}** — {SCOPE[d][1]}" for d in rollup(OUT)) or "_none_")

    A("\n## Layer map: ST → neo's shared/server/client\n")
    A("ST splits cleanly into **server (`src/`)** and **client (`public/`)** — but has **no `shared` layer**. "
      "The logic neo factors into `src/shared/` is, in ST, client-side or duplicated across both. That absence "
      "(and the resulting duplication) is one of the sharpest structural differences.\n")
    A("| neo `shared/` concern | ST layer | ST location | Note |")
    A("|---|---|---|---|")
    for concern, layer, loc_, note in SHARED_MAP:
        A(f"| `{concern}` | {layer} | `{loc_}` | {note} |")
    A("")

    A("## Frontend surface inventory\n")
    A("_Surface-area only (file/LOC counts), not a call-graph. ST's client is the bulk of the project; "
      "neo's client is largely stubs pending the UI build._\n")
    A(f"**neo client:** {layers['neo_client'][0]} files / {layers['neo_client'][1]:,} LOC "
      "(mostly `.gitkeep` stubs under `src/client/features/*`).\n")
    A("**ST client (`public/scripts/`) by area:**\n")
    A("| Area | files | LOC |")
    A("|---|--:|--:|")
    for area, (f, l) in sorted(layers["st_fe"].items(), key=lambda kv: -kv[1][1])[:20]:
        A(f"| `{area}` | {f} | {l:,} |")
    A("")
    return "\n".join(L)


def git_date() -> str:
    try:
        return subprocess.run(["git", "log", "-1", "--format=%cs"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "docs" / "api-map.md"))
    ap.add_argument("--date", default=None, help="snapshot date (default: last git commit date)")
    ap.add_argument("--json", action="store_true", help="also print raw parsed data as JSON to stdout")
    args = ap.parse_args()

    st_routes = parse_st_routes()
    neo_procs, neo_hono = parse_neo()
    layers = parse_layers()
    report = render(st_routes, neo_procs, neo_hono, layers, args.date or git_date())

    Path(args.out).write_text(report, encoding="utf-8")
    print(f"wrote {args.out}")
    print(f"  ST routes={len(st_routes)}  neo tRPC procs={len(neo_procs)}  neo Hono routes={len(neo_hono)}")
    if args.json:
        print(json.dumps({"st_routes": st_routes, "neo_procs": neo_procs, "neo_hono": neo_hono}, indent=2))


if __name__ == "__main__":
    main()
