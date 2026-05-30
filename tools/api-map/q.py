#!/usr/bin/env python3
"""Query helper over docs/api-map.json — so a future session can 'do shit' with the parsed map
without hand-navigating the JSON. Auto-(re)generates the map if it's missing.

  pnpm api:q                          # summary: counts, subsystems (hook totals + flags), domain verdicts
  pnpm api:q hooks world-info         # WHERE world-info hooks in — per file: symbol@[lines] (kinds)
  pnpm api:q subsystems               # every subsystem + st/neo hook totals + SKIP/caveat flags
  pnpm api:q find getWorldInfoPrompt  # every subsystem/file that calls/imports/new's a symbol (substring)
  pnpm api:q proc chat.send           # neo tRPC procs matching: kind/tier, file:line, params
  pnpm api:q route worldinfo          # ST routes matching: method path, file:line, req.body params
  pnpm api:q domain rag               # a domain's scope verdict + its routes/procs

Notes:
  - "hooks" are deduped per (symbol, file): one row, with the line list and total `sites`.
  - hook `kinds` ∈ {call, import, new}. A subsystem flagged SKIP (e.g. instruct) is mapped so you can
    SEE its exclusive surface to AVOID porting, not to build.
  - `--fresh` forces regeneration first.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = ROOT / "docs" / "api-map.json"


def load(fresh: bool) -> dict:
    if fresh or not JSON_PATH.exists():
        subprocess.run([sys.executable, str(Path(__file__).with_name("map_api.py"))], check=True)
    return json.loads(JSON_PATH.read_text(encoding="utf-8"))


def _hooks_by_file(side: dict) -> str:
    out = []
    by_file: dict[str, list] = {}
    for h in side["hooks"]:
        by_file.setdefault(h["file"], []).append(h)
    for f in sorted(by_file):
        items = "; ".join(f"{h['symbol']}@{h['lines']} ({','.join(h['kinds'])})" for h in sorted(by_file[f], key=lambda x: x["symbol"]))
        out.append(f"  {f}\n      {items}")
    return "\n".join(out)


def cmd_summary(d: dict) -> None:
    st, neo = d["st"], d["neo"]
    print(f"generated {d['generated']}")
    print(f"ST routes {len(st['routes'])} (+{st['skipped_provider_routes']} other-provider routes skipped) "
          f"· neo {len(neo['procedures'])} tRPC procs + {len(neo['hono'])} Hono routes "
          f"· parse_errors {len(d.get('parse_errors', []))}")
    print("\nsubsystems  (st / neo = distinct symbol×file hooks):")
    for n, e in d["subsystems"].items():
        flags = " ".join(t for t, k in (("SKIP", "skip"), ("caveat", "caveat")) if e.get(k))
        print(f"  {n:16} st={e['st']['hook_count']:<4} neo={e['neo']['hook_count']:<4} {flags}")
    print("\ndomains:")
    for dom, s in sorted(d["scope"].items()):
        print(f"  {s['verdict']:12} {dom}")


def cmd_subsystems(d: dict) -> None:
    for n, e in d["subsystems"].items():
        print(f"{n}: st {e['st']['hook_count']} hooks/{len(e['st']['hook_files'])} files "
              f"(sites {e['st']['site_count']}) · neo {e['neo']['hook_count']}/{len(e['neo']['hook_files'])}")
        if e.get("skip"):
            print(f"    SKIP — {e['skip']}")
        if e.get("caveat"):
            print(f"    caveat — {e['caveat']}")


def cmd_hooks(d: dict, name: str) -> None:
    e = d["subsystems"].get(name)
    if not e:
        print(f"no subsystem '{name}'. have: {', '.join(d['subsystems'])}")
        return
    if e.get("skip"):
        print(f"⚠ SKIP — {e['skip']}")
    if e.get("caveat"):
        print(f"⚠ caveat — {e['caveat']}")
    for side in ("st", "neo"):
        s = e[side]
        if not s["home"] and not s["hooks"]:
            continue
        print(f"\n[{side}] home={s['home']} · exports={len(s['exports'])} · "
              f"hooks={s['hook_count']} (sites={s['site_count']}, files={len(s['hook_files'])})")
        if s["hooks"]:
            print(_hooks_by_file(s))


def cmd_find(d: dict, sym: str) -> None:
    needle, hits = sym.lower(), 0
    for n, e in d["subsystems"].items():
        for side in ("st", "neo"):
            for h in e[side]["hooks"]:
                if needle in h["symbol"].lower():
                    print(f"  [{n}/{side}] {h['symbol']}  {h['file']}@{h['lines']} ({','.join(h['kinds'])})")
                    hits += 1
    if not hits:
        print(f"no subsystem hooks reference '{sym}' (note: find only searches subsystem hook symbols)")


def cmd_proc(d: dict, sub: str) -> None:
    needle, hits = sub.lower(), 0
    for p in d["neo"]["procedures"]:
        if needle in p["path"].lower():
            print(f"  {p['path']} [{p['kind']}/{p['tier']}] {p['file']}:{p['line']} params={p['params']}")
            hits += 1
    if not hits:
        print(f"no neo procedure matching '{sub}'")


def cmd_route(d: dict, sub: str) -> None:
    needle, hits = sub.lower(), 0
    for r in d["st"]["routes"]:
        if needle in r["path"].lower():
            print(f"  {r['method']} {r['path']}  {r['file']}:{r['line']} params={r['params']}")
            hits += 1
    if not hits:
        print(f"no ST route matching '{sub}'")


def cmd_domain(d: dict, name: str) -> None:
    s = d["scope"].get(name)
    print(f"{name}: {s['verdict']} — {s['note']}\n" if s else f"(no scope verdict for '{name}')\n")
    st = [r for r in d["st"]["routes"] if r["domain"] == name]
    neo = [p for p in d["neo"]["procedures"] + d["neo"]["hono"] if p["domain"] == name]
    print(f"ST routes ({len(st)}):")
    for r in st:
        print(f"  {r['method']} {r['path']} ({r['file']}:{r['line']})")
    print(f"neo ({len(neo)}):")
    for p in neo:
        label = p["path"] if "kind" in p else f"{p['method']} {p['path']}"
        print(f"  {label} ({p['file']}:{p['line']})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fresh", action="store_true", help="regenerate api-map.json before querying")
    sub = ap.add_subparsers(dest="cmd")
    for name in ("subsystems",):
        sub.add_parser(name)
    for name, arg in (("hooks", "subsystem"), ("find", "symbol"), ("proc", "query"),
                      ("route", "query"), ("domain", "name")):
        sub.add_parser(name).add_argument(arg)
    args = ap.parse_args()
    d = load(args.fresh)

    if args.cmd == "hooks":
        cmd_hooks(d, args.subsystem)
    elif args.cmd == "subsystems":
        cmd_subsystems(d)
    elif args.cmd == "find":
        cmd_find(d, args.symbol)
    elif args.cmd == "proc":
        cmd_proc(d, args.query)
    elif args.cmd == "route":
        cmd_route(d, args.query)
    elif args.cmd == "domain":
        cmd_domain(d, args.name)
    else:
        cmd_summary(d)


if __name__ == "__main__":
    main()
