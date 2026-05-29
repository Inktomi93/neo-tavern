#!/usr/bin/env python3
"""Map SillyTavern vs neo-tavern with tree-sitter → docs/api-map.json (machine-readable, for an LLM)
plus a short docs/api-map.md summary.

The JSON is the primary artifact (consumed by a future session, not meant for human reading). It carries:
  • neo.procedures  — tRPC procs: {path, kind, tier, file, line, params:[zod .input fields]}
  • neo.hono        — Hono routes: {method, path, file, line}
  • st.routes       — ST REST routes: {method, path, file, line, params:[req.body.* fields]} (providers
                      filtered to openai/openrouter/custom only — the rest dropped into providers-other)
  • subsystems      — THE hook map: for world-info / macro / persona / themes / backgrounds / regex /
                      prompt-assembly, every call site + import of that subsystem's exported symbols
                      across ST (public/scripts + src) AND neo (src), as {symbol, file, line, kind}.
  • domains, layers, scope, shared_layer_map — capability rollups + the shared/server/client comparison.

tree-sitter is used two ways (best-practice split): node-walking for structured per-route/proc analysis,
and the QUERY API (QueryCursor) for fast bulk call-site/import extraction across all ~500 files.

Run:  pnpm api:map   (= uv sync + uv run python tools/api-map/map_api.py)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import tree_sitter_javascript as tsjs
import tree_sitter_typescript as tsts
from tree_sitter import Language, Parser, Query, QueryCursor

ROOT = Path(__file__).resolve().parents[2]
ST = ROOT / "references" / "sillytavern"
JS = Language(tsjs.language())
TS = Language(tsts.language_typescript())

KIND_METHODS = {"query", "mutation", "subscription"}
HTTP_METHODS = {"get", "post", "put", "delete", "patch"}

# Providers in scope: openai + openrouter + custom (custom is hosted by backends/chat-completions.js).
# Everything else (anthropic/google/novelai/horde/kobold/azure/volcengine/minimax/nanogpt/text-completions)
# is dropped into providers-other and ignored.
PROVIDER_KEEP_FILES = {"openai", "openrouter", "backends/chat-completions"}

HAVE, WANT, OUT, NEO_ONLY = "✅ HAVE", "🎯 WANT", "🚫 OUT", "🟣 NEO-ONLY"
SCOPE: dict[str, tuple[str, str]] = {
    "chat": (HAVE, "send/swipe/edit/fork/branch/compaction — the full turn pipeline."),
    "groups": (WANT, "multi-character RP — a real ST capability we lack; sizable, not yet scoped."),
    "characters": (HAVE, "library + copy-on-write versioned editor; avatars via assets."),
    "world-info": (HAVE, "scope-driven activation; simpler than ST (no recursion/secondary keys) — under review."),
    "personas": (HAVE, "first-class persona router; ST has no dedicated endpoint."),
    "presets": (HAVE, "versioned prompt presets (PromptConfig blob)."),
    "rag": (NEO_ONLY, "corpus semantic search + analytics — the differentiator. ST 'vector' = per-chat only; ST 'search' = web search."),
    "auth": (HAVE, "BFF cookie + OIDC + per-user AES-GCM credentials + admin ladder. ST stores secrets PLAINTEXT."),
    "assets": (HAVE, "content-addressed blob store by hash; ST splits into avatars/thumbnails/backgrounds/sprites."),
    "settings": (HAVE, "typed AppSettings/UserSettings."),
    "tags": (HAVE, "first-class tag router + typed junctions."),
    "import-export": (HAVE, "PNG card + JSONL chat import/export."),
    "providers": (HAVE, "openai + openrouter + custom only (others skipped). neo: Claude (Max-sub + OR skin) + OR catalog."),
    "providers-other": (OUT, "ST's ~22 other providers — skipped per scope."),
    "stats-analytics": (NEO_ONLY, "ST chat-stats → neo corpus analytics (planned) + /_debug."),
    "meta": (HAVE, "health/echo utility."),
    "tokenizers": (OUT, "neo tokenizes internally; not an endpoint."),
    "image-gen": (OUT, "no image-gen/SD/caption/classify (slop guard)."),
    "tts": (OUT, "no TTS/STT (slop guard)."),
    "translate": (OUT, "no translation (slop guard)."),
    "ui-cosmetic": (WANT, "themes / backgrounds — UNDER REVIEW (owner now interested); was OUT."),
    "quick-replies": (OUT, "UI macro/quick-reply feature, not core."),
    "extensions": (OUT, "no third-party extension system (single-user)."),
    "content-mgr": (OUT, "ST default-content downloader."),
    "maintenance": (OUT, "ST file-maintenance/backups; SQLite handles this differently."),
    "web-search": (OUT, "ST web/YouTube/SearXNG search — not RP/corpus."),
    "other": ("❓ ?", "unclassified."),
}
ORDER = {NEO_ONLY: 0, WANT: 1, HAVE: 2, "❓ ?": 3, OUT: 4}

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
    "openai": "providers", "google": "providers", "anthropic": "providers", "novelai": "providers",
    "horde": "providers", "openrouter": "providers", "nanogpt": "providers", "azure": "providers",
    "volcengine": "providers", "minimax": "providers", "backends/text-completions": "providers",
    "backends/kobold": "providers", "backends/chat-completions": "providers",
}
NEO_KEY_DOMAIN = {
    "character": "characters", "persona": "personas", "chat": "chat", "credentials": "auth",
    "preset": "presets", "corpus": "rag", "search": "rag", "settings": "settings", "tag": "tags",
    "userAdmin": "auth", "worldInfo": "world-info", "health": "meta", "echo": "meta",
    "models": "providers", "rawModels": "providers", "orCredits": "providers", "orActivity": "providers",
    "orProviders": "providers", "orEndpoints": "providers", "orGenerationCost": "providers",
}

# Subsystems to build a HOOK MAP for: home file(s) whose exports we trace everywhere they're called/imported.
SUBSYSTEMS = {
    "world-info": {"st": ["public/scripts/world-info.js"],
                   "neo": ["src/server/domain/world-info/service.ts", "src/shared/prompt-assemble.ts"]},
    "macro": {"st": ["public/scripts/macros.js", "public/scripts/macros/macro-system.js"],
              "neo": ["src/shared/macro/index.ts", "src/shared/macro/registry.ts"]},
    "persona": {"st": ["public/scripts/personas.js"], "neo": ["src/server/domain/persona/service.ts"]},
    "themes": {"st": ["public/scripts/power-user.js"], "neo": []},
    "backgrounds": {"st": ["public/scripts/backgrounds.js"], "neo": []},
    "regex": {"st": ["public/scripts/extensions/regex/engine.js"],
              "neo": ["src/shared/regex.ts", "src/server/domain/_shared/regex.ts"]},
    "prompt-assembly": {"st": ["src/prompt-converters.js"], "neo": ["src/shared/prompt-assemble.ts"]},
}

# Per-subsystem accuracy caveats (where the home file isn't cohesive, the hook count is a superset).
SUBSYSTEM_CAVEATS = {
    "themes": "Home power-user.js is a kitchen-sink module — hook count is a SUPERSET (all power-user "
              "refs, not theme-specific). Treat as the 'power-user surface'; narrow to theme symbols if needed.",
}

SHARED_MAP = [
    ("shared/macro/* (macro engine)", "client", "public/scripts/macros/macro-system.js + definitions/*",
     "ST runs macros CLIENT-side; neo centralizes them server-side in shared."),
    ("shared/prompt-assemble + prompt-config", "split", "public/script.js Generate() + src/prompt-converters.js",
     "ST splits prompt build across client + a server converter; neo has ONE shared assembler."),
    ("shared/regex (script engine)", "client-ext", "public/scripts/extensions/regex/{index,engine}.js",
     "ST regex is a CLIENT EXTENSION; neo bakes it into shared + server _shared/regex."),
    ("shared/generation (params vocab)", "client", "public/scripts/*settings UI state", "client-side knobs."),
    ("shared/models (catalog)", "client", "public/scripts model constants", "client-side lists."),
    ("shared/time (the only parser)", "none", "scattered inline Date handling", "ST has NO central time util."),
    ("shared/*-types (Zod-derived)", "none", "implicit (untyped JS)", "ST has no shared type layer."),
]

PARSE_ERRORS: list[str] = []


# ── tree-sitter helpers ──
def walk(node):
    yield node
    for c in node.children:
        yield from walk(c)

def field(node, name):
    return node.child_by_field_name(name) if node else None

def txt(node) -> str:
    return node.text.decode("utf-8", "replace") if node is not None else ""

def line_of(node) -> int:
    return node.start_point[0] + 1

def parse_src(lang, data: bytes, label: str):
    tree = Parser(lang).parse(data)
    if tree.root_node.has_error:
        PARSE_ERRORS.append(label)
    return tree

def first_string_arg(call) -> str | None:
    args = field(call, "arguments")
    for a in (args.children if args else []):
        if a.type == "string":
            frag = next((c for c in a.children if c.type == "string_fragment"), None)
            return txt(frag) if frag else ""
    return None

def is_member_call(call, prop_set, obj_name=None) -> str | None:
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

def zod_object_keys(node) -> list[str]:
    """Keys of a `z.object({ a: …, b: … })` call node (else [])."""
    if node is None or is_member_call(node, {"object"}) is None:
        return []
    args = field(node, "arguments")
    obj = next((c for c in (args.children if args else []) if c.type == "object"), None)
    return [txt(field(p, "key")) for p in object_pairs(obj)]

def file_const_schemas(root) -> dict[str, list[str]]:
    """Top-level `const NAME = z.object({...})` → field names, for resolving referenced .input() schemas."""
    out: dict[str, list[str]] = {}
    for n in walk(root):
        if n.type == "variable_declarator":
            keys = zod_object_keys(field(n, "value"))
            if keys:
                out[txt(field(n, "name"))] = keys
    return out

def proc_params(value, const_schemas: dict[str, list[str]]) -> list[str]:
    """Fields from `<tier>Procedure.input(<z.object|const>)…` (else [])."""
    cur = value
    while cur is not None:
        if cur.type == "call_expression":
            if is_member_call(cur, {"input"}) is not None:
                args = field(cur, "arguments")
                arg = next((c for c in (args.children if args else []) if c.type not in ("(", ")", ",")), None)
                if arg is None:
                    return []
                keys = zod_object_keys(arg)
                if keys:
                    return keys
                return const_schemas.get(txt(arg), []) if arg.type == "identifier" else []
            cur = field(cur, "function")
        elif cur.type == "member_expression":
            cur = field(cur, "object")
        else:
            break
    return []

def chain_kind_tier(value) -> tuple[str | None, str | None]:
    props, base, cur = [], None, value
    while cur is not None:
        if cur.type == "call_expression":
            cur = field(cur, "function")
        elif cur.type == "member_expression":
            props.append(txt(field(cur, "property")))
            cur = field(cur, "object")
        elif cur.type == "identifier":
            base = txt(cur); break
        else:
            break
    return next((p for p in props if p in KIND_METHODS), None), base

def route_body_params(call) -> list[str]:
    """`request.body.X` / `req.body.X` reads inside the route handler → param names."""
    args = field(call, "arguments")
    params: set[str] = set()
    for a in (args.children if args else []):
        if a.type in ("arrow_function", "function_expression"):
            for m in walk(a):
                if m.type == "member_expression":
                    obj, prop = field(m, "object"), field(m, "property")
                    if prop and prop.type == "property_identifier" and txt(obj) in ("request.body", "req.body"):
                        params.add(txt(prop))
    return sorted(params)


# ── exports + reference index (the hook map) ──
def exports_of(root) -> set[str]:
    names: set[str] = set()
    for n in walk(root):
        if n.type != "export_statement":
            continue
        for c in walk(n):
            if c.type in ("function_declaration", "generator_function_declaration", "class_declaration"):
                names.add(txt(field(c, "name")))
            elif c.type == "variable_declarator":
                nm = field(c, "name")
                if nm and nm.type == "identifier":
                    names.add(txt(nm))
            elif c.type == "export_specifier":
                names.add(txt(field(c, "name")))
    names.discard("")
    return names

_CALL_Q = {JS: Query(JS, "(call_expression function: (identifier) @fn)"),
           TS: Query(TS, "(call_expression function: (identifier) @fn)")}
_IMPORT_Q = {JS: Query(JS, "(import_specifier name: (identifier) @n)"),
             TS: Query(TS, "(import_specifier name: (identifier) @n)")}

def build_ref_index(files: list[Path], lang, base: Path) -> dict[str, list[tuple[str, int, str]]]:
    """symbol → [(relpath, line, 'call'|'import')] across `files`, via the tree-sitter QUERY API (fast)."""
    idx: dict[str, list[tuple[str, int, str]]] = defaultdict(list)
    for fp in files:
        try:
            tree = Parser(lang).parse(fp.read_bytes())
        except OSError:
            continue
        rel = str(fp.relative_to(base))
        for q, kind in ((_CALL_Q[lang], "call"), (_IMPORT_Q[lang], "import")):
            for nodes in QueryCursor(q).captures(tree.root_node).values():
                for node in nodes:
                    idx[txt(node)].append((rel, line_of(node), kind))
    return idx

def build_subsystems() -> dict:
    st_files = list((ST / "public/scripts").rglob("*.js")) + list((ST / "src").rglob("*.js"))
    neo_files = [p for ext in ("*.ts", "*.tsx") for p in (ROOT / "src").rglob(ext) if ".test." not in p.name]
    st_idx = build_ref_index(st_files, JS, ST)
    neo_idx = build_ref_index(neo_files, TS, ROOT)
    out: dict[str, dict] = {}
    for name, homes in SUBSYSTEMS.items():
        entry = {}
        for side, lang, idx, base in (("st", JS, st_idx, ST), ("neo", TS, neo_idx, ROOT)):
            exports, home_rel = set(), []
            for h in homes[side]:
                hp = base / h
                if not hp.exists():
                    continue
                home_rel.append(h)
                exports |= exports_of(Parser(lang).parse(hp.read_bytes()).root_node)
            hooks = [{"symbol": sym, "file": rel, "line": ln, "kind": kind}
                     for sym in sorted(exports)
                     for rel, ln, kind in idx.get(sym, []) if rel not in home_rel]
            entry[side] = {"home": home_rel, "exports": sorted(exports), "hook_count": len(hooks),
                           "hook_files": sorted({h["file"] for h in hooks}), "hooks": hooks}
        if name in SUBSYSTEM_CAVEATS:
            entry["caveat"] = SUBSYSTEM_CAVEATS[name]
        out[name] = entry
    return out


# ── route / procedure parsers ──
def parse_st_routes() -> list[dict]:
    startup = (ST / "src/server-startup.js").read_text(encoding="utf-8", errors="replace")
    tree = parse_src(JS, startup.encode(), "ST src/server-startup.js")
    var2file, mounts = {}, []
    for n in walk(tree.root_node):
        if n.type == "import_statement":
            src = txt(field(n, "source")).strip("'\"")
            if "./endpoints/" in src:
                file = src.split("./endpoints/")[1].removesuffix(".js")
                for alias in walk(n):
                    if alias.type == "import_specifier" and txt(field(alias, "name")) == "router" and field(alias, "alias"):
                        var2file[txt(field(alias, "alias"))] = file
        if is_member_call(n, {"use"}, "app"):
            args = field(n, "arguments")
            kids = [c for c in (args.children if args else []) if c.type not in ("(", ")", ",")]
            if len(kids) >= 2 and kids[0].type == "string" and kids[1].type == "identifier":
                frag = next((c for c in kids[0].children if c.type == "string_fragment"), None)
                prefix = txt(frag) if frag else ""
                if prefix.startswith("/api/"):
                    mounts.append((prefix, txt(kids[1])))
    routes = []
    for prefix, var in mounts:
        file = var2file.get(var)
        if not file:
            continue
        fp = ST / "src" / "endpoints" / (file + ".js")
        if not fp.exists():
            continue
        sub = prefix[len("/api/"):]
        domain = ST_PREFIX_DOMAIN.get(sub, "other")
        if domain == "providers" and file not in PROVIDER_KEEP_FILES:
            domain = "providers-other"
        ftree = parse_src(JS, fp.read_bytes(), f"ST src/endpoints/{file}.js")
        for n in walk(ftree.root_node):
            method = is_member_call(n, HTTP_METHODS, "router")
            if not method:
                continue
            path = first_string_arg(n)
            if path is None:
                continue
            full = prefix.rstrip("/") + ("" if path == "/" else path if path.startswith("/") else "/" + path)
            routes.append({"method": method.upper(), "path": full, "file": file + ".js",
                           "line": line_of(n), "domain": domain, "params": route_body_params(n)})
    return routes

def parse_neo() -> tuple[list[dict], list[dict]]:
    rtree = parse_src(TS, (ROOT / "src/server/trpc/router.ts").read_bytes(), "neo trpc/router.ts")
    rconsts = file_const_schemas(rtree.root_node)
    var2key, procs = {}, []
    for n in walk(rtree.root_node):
        if not is_t_router_call(n):
            continue
        for pair in object_pairs(router_object_arg(n)):
            key, val = txt(field(pair, "key")), field(pair, "value")
            if val is None:
                continue
            if val.type == "identifier" and txt(val).endswith("Router"):
                var2key[txt(val)] = key
            else:
                kind, tier = chain_kind_tier(val)
                if tier and tier.endswith("Procedure"):
                    procs.append({"path": key, "kind": kind, "tier": tier.replace("Procedure", ""),
                                  "file": "trpc/router.ts", "line": line_of(pair),
                                  "domain": NEO_KEY_DOMAIN.get(key, "other"), "params": proc_params(val, rconsts)})
        break
    for fp in sorted((ROOT / "src/server/trpc/routers").glob("*.ts")):
        ftree = parse_src(TS, fp.read_bytes(), f"neo trpc/routers/{fp.name}")
        consts = file_const_schemas(ftree.root_node)
        for n in walk(ftree.root_node):
            if n.type != "variable_declarator":
                continue
            val = field(n, "value")
            if not (val and is_t_router_call(val)):
                continue
            key = var2key.get(txt(field(n, "name")), txt(field(n, "name")).replace("Router", ""))
            domain = NEO_KEY_DOMAIN.get(key, "other")
            for pair in object_pairs(router_object_arg(val)):
                pname, pval = txt(field(pair, "key")), field(pair, "value")
                kind, tier = chain_kind_tier(pval) if pval else (None, None)
                if tier and tier.endswith("Procedure"):
                    procs.append({"path": f"{key}.{pname}", "kind": kind, "tier": tier.replace("Procedure", ""),
                                  "file": fp.name, "line": line_of(pair), "domain": domain,
                                  "params": proc_params(pval, consts)})
    hono = []
    for rel in ["src/server/app.ts", "src/server/auth-oidc.ts", "src/server/import-http.ts"]:
        htree = parse_src(TS, (ROOT / rel).read_bytes(), f"neo {rel}")
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
            hono.append({"method": method.upper(), "path": path, "file": rel.split("/")[-1],
                         "line": line_of(n), "domain": domain})
    return procs, hono


def loc(paths) -> list[int]:
    files = list(paths)
    total = sum(sum(1 for _ in p.open("rb")) for p in files if p.exists())
    return [len(files), total]

def parse_layers() -> dict:
    return {
        "neo_shared": loc((ROOT / "src/shared").rglob("*.ts")),
        "neo_server": loc((ROOT / "src/server").rglob("*.ts")),
        "neo_client": loc(p for ext in ("*.ts", "*.tsx") for p in (ROOT / "src/client").rglob(ext)),
        "st_server": loc((ST / "src").rglob("*.js")),
        "st_client": loc((ST / "public/scripts").rglob("*.js")),
        "st_shared": [0, 0],
    }


def _group(items, k="domain"):
    g = defaultdict(list)
    for it in items:
        g[it[k]].append(it)
    return g

def render_md(st_routes, neo_procs, neo_hono, layers, subsystems, date) -> str:
    st_by = _group(st_routes)
    neo_by = _group(neo_procs + neo_hono)
    domains = sorted(set(st_by) | set(neo_by), key=lambda d: (ORDER.get(SCOPE.get(d, ("❓ ?", ""))[0], 9), d))
    L = ["# API & layer map — SillyTavern vs neo-tavern (summary)\n",
         f"> Generated by `tools/api-map/map_api.py` (tree-sitter). **Full machine-readable data: "
         f"`docs/api-map.json`** (hooks, params, refs). Regenerate: `pnpm api:map`. Snapshot: {date}.\n",
         "## Summary\n",
         f"- ST: {len(st_routes)} routes (providers filtered to openai/openrouter/custom) · neo: "
         f"{len(neo_procs)} tRPC procs + {len(neo_hono)} Hono routes.",
         f"- Layers (LOC): ST server {layers['st_server'][1]:,} / client {layers['st_client'][1]:,} / **shared 0** · "
         f"neo shared {layers['neo_shared'][1]:,} / server {layers['neo_server'][1]:,} / client {layers['neo_client'][1]:,}.",
         "- Parse coverage: " + (f"⚠ {len(PARSE_ERRORS)} file(s) with ERROR nodes" if PARSE_ERRORS else "all parsed files clean") + ".",
         "", "## Domains\n", "| Domain | Scope | ST | neo |", "|---|---|--:|--:|"]
    L += [f"| {d} | {SCOPE.get(d, ('❓ ?', ''))[0]} | {len(st_by.get(d, []))} | {len(neo_by.get(d, []))} |" for d in domains]
    L += ["", "## Subsystem hook counts (detail → api-map.json `subsystems`)\n",
          "| Subsystem | ST hooks (files) | neo hooks (files) |", "|---|--:|--:|"]
    for name, e in subsystems.items():
        L.append(f"| {name} | {e['st']['hook_count']} ({len(e['st']['hook_files'])}) | "
                 f"{e['neo']['hook_count']} ({len(e['neo']['hook_files'])}) |")
    return "\n".join(L) + "\n"


def git_date() -> str:
    try:
        return subprocess.run(["git", "log", "-1", "--format=%cs"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json-out", default=str(ROOT / "docs" / "api-map.json"))
    ap.add_argument("--md-out", default=str(ROOT / "docs" / "api-map.md"))
    ap.add_argument("--date", default=None)
    args = ap.parse_args()

    st_all = parse_st_routes()
    # Honor "skip the extra providers": drop providers-other from the route list (counted, not listed).
    st_routes = [r for r in st_all if r["domain"] != "providers-other"]
    skipped_provider_routes = len(st_all) - len(st_routes)
    neo_procs, neo_hono = parse_neo()
    layers = parse_layers()
    subsystems = build_subsystems()
    date = args.date or git_date()

    data = {
        "generated": date,
        "note": "Machine-readable map for an LLM. Providers filtered to openai/openrouter/custom. "
                "subsystems = hook map (call sites + imports of each subsystem's exports across ST + neo).",
        "scope": {d: {"verdict": v[0], "note": v[1]} for d, v in SCOPE.items()},
        "layers": layers,
        "shared_layer_map": [{"concern": c, "st_layer": l, "st_location": loc_, "note": nt}
                             for c, l, loc_, nt in SHARED_MAP],
        "neo": {"procedures": neo_procs, "hono": neo_hono},
        "st": {"routes": st_routes, "skipped_provider_routes": skipped_provider_routes},
        "subsystems": subsystems,
        "parse_errors": sorted(PARSE_ERRORS),
    }
    Path(args.json_out).write_text(json.dumps(data, indent=2), encoding="utf-8")
    Path(args.md_out).write_text(render_md(st_routes, neo_procs, neo_hono, layers, subsystems, date), encoding="utf-8")
    print(f"wrote {args.json_out} + {args.md_out}", file=sys.stderr)
    print(f"  ST routes={len(st_routes)} neo procs={len(neo_procs)} hono={len(neo_hono)} "
          f"parse_errors={len(PARSE_ERRORS)}", file=sys.stderr)
    for name, e in subsystems.items():
        print(f"  hooks[{name}]: st={e['st']['hook_count']} neo={e['neo']['hook_count']}", file=sys.stderr)


if __name__ == "__main__":
    main()
