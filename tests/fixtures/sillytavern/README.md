# SillyTavern import fixtures (real export)

A real SillyTavern character + chats, exported from the owner's running ST instance
(`docker volume sillytavern_data` → `default-user/`) **on purpose** as a test corpus — not private
RP. Used by the import suite (`domain/import` parsers + the first-class import feature) so we test
against the *actual* ST on-disk format, not hand-written approximations.

## Contents
- `characters/Test Character.png` — a V2+V3 card (embeds both the `chara` (V2) and `ccv3` (V3) tEXt
  chunks). Short description, no greeting — exercises the minimal-card path.
- `chats/Test Character/*.jsonl` — 7 chats covering the shapes the importer must handle:
  - several normal linear chats (2–5 messages),
  - an **empty chat** (0 messages — header only),
  - a **Branch** + its **Checkpoint** (7 messages each), whose `chat_metadata.main_chat` references
    the parent chat by filename — the exact ref the importer's branch-linking resolves.

## Layout
Mirrors an ST user-profile dir (`characters/` + `chats/<charDir>/`), so `collectBundlesFromDir` can
walk this directory directly, and a zip of it is a valid bulk-import payload.

All 7 chats + the card parse cleanly through `parseCardPng` / `parseChatJsonl` (verified at import).
