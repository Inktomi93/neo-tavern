# Backend Expansion Implementation Plan

This plan details the steps to build the missing backend domain entities, properly wired into `neo-tavern`'s layered architecture. Every piece is verified against `src/db/schema.ts` and the established tRPC patterns.

## User Review Required
> [!IMPORTANT]
> - File uploads (Avatars/Cards) cannot go through tRPC easily. I plan to add a dedicated Hono route (`/api/assets`) for multipart uploads and blob serving, leveraging the existing `cas.ts` store. The domain layer will orchestrate this.
> - Do you agree with building these components iteratively in the order proposed?

## 1. Asset Serving & Uploads (Hono Route)
The foundation for character cards and persona avatars.

- **Files to Edit:** 
  - `src/server/index.ts` (Add `app.post("/api/assets/upload")` and `app.get("/api/blob/:hash")`)
  - `src/server/domain/assets/service.ts` (Existing, provides `store()` method)
- **DB Schema Addressed:** `assets`
  - Columns: `id`, `kind` ("card"|"avatar"|"export"), `mime`, `size`, `hash`, `uploadedAt`
- **Logic Details:** 
  - `GET /api/blob/:hash`: Streams bytes from CAS `cas.read()`.
  - `POST /api/assets/upload`: Accepts multipart file upload, calls `ctx.services.assets.store()`, returns `{ assetId, hash }`.

## 2. Character Domain (`characterRouter`)
Characters are immutable copy-on-write across versions.

- **Files to Create:**
  - `src/server/domain/character/service.ts`
  - `src/server/domain/character/types.ts`
  - `src/server/trpc/routers/character.ts`
- **DB Schema Addressed:** 
  - `characters` (`id`, `ownerId`, `handle`, `currentVersionId`, `starred`, `archived`, `createdAt`)
  - `characterVersions` (`id`, `characterId`, `version`, `name`, `description`, `personality`, `scenario`, `greetings`, `exampleMessages`, `systemPrompt`, `postHistoryInstructions`, `tags`, `creatorNotes`, `avatarAssetId`, `createdAt`)
- **Procedures to Build:**
  - `create`: Inserts into `characters` and `characterVersions` (version 1). Links `avatarAssetId`.
  - `list`: Selects `characters` joined with their `currentVersionId` row.
  - `get`: Full detail of a character and its active version.
  - `update`: Updates fields. Copy-on-write: if current version is pinned by any `chats.characterVersionId`, it inserts a new `characterVersions` row (version N+1) and updates `characters.currentVersionId`. Else, mutates in place.
  - `updateAvatar`: Points `avatarAssetId` to a new CAS blob.
  - `delete`: Deletes `characters` row. (Cascades to versions. Fails if pinned by chats due to RESTRICT FK).
  - `star` / `archive`: Toggles `starred` / `archived` booleans.

## 3. Persona Domain (`personaRouter`)
Personas are the identities the user plays as.

- **Files to Create:**
  - `src/server/domain/persona/service.ts`
  - `src/server/trpc/routers/persona.ts`
- **DB Schema Addressed:** `personas`
  - Columns: `id`, `ownerId`, `name`, `description`, `avatarAssetId`, `metadata`, `createdAt`
- **Procedures to Build:**
  - `create`, `list`, `get`, `update`, `delete`. 
  - Simple CRUD. Deletion sets `chats.personaId` to NULL (via DB SET NULL).

## 4. Chat Router Gaps (`chatRouter`)
Completing the chat lifecycle mutations.

- **Files to Edit:**
  - `src/server/domain/chat/lifecycle.ts` (Add domain methods)
  - `src/server/domain/chat/types.ts` (Add interface methods)
  - `src/server/domain/chat/service.ts` (Wire up)
  - `src/server/trpc/routers/chat.ts` (Add tRPC procedures)
- **DB Schema Addressed:** `chats`
  - Columns: `id`, `title`, `starred`, `archived`
- **Procedures to Build:**
  - `delete`: Hard delete `chats` row (cascades to messages, events, digests, segments).
  - `updateTitle`: Updates `chats.title`.
  - `star` / `archive`: Toggles `chats.starred` and `chats.archived`.

## 5. World Info Domain (`worldInfoRouter`)
Managing lorebooks and their explicit attachments.

- **Files to Create:**
  - `src/server/domain/world-info/service.ts`
  - `src/server/trpc/routers/world-info.ts`
- **DB Schema Addressed:** 
  - `worldBooks` (`id`, `ownerId`, `name`, `description`, `createdAt`)
  - `worldEntries` (`id`, `worldBookId`, `title`, `content`, `legacyKeys`, `enabled`, `priority`, `metadata`)
  - `chatWorldEntries` (`chatId`, `entryId`, `scope`, `pinned`)
  - `characterVersionWorldEntries` (`characterVersionId`, `entryId`, `scope`)
- **Procedures to Build:**
  - `listBooks`, `getBook`, `createBook`, `updateBook`, `deleteBook` (Cascades to entries).
  - `createEntry`, `updateEntry`, `deleteEntry`.
  - `attachToChat`, `detachFromChat`, `attachToCharacter`, `detachFromCharacter` (Insert/delete junction table rows).

## 6. Tag Domain (`tagRouter`)
Simple global tags applied polymorphically.

- **Files to Create:**
  - `src/server/domain/tag/service.ts`
  - `src/server/trpc/routers/tag.ts`
- **DB Schema Addressed:** 
  - `tags` (`id`, `ownerId`, `name`, `color`, `source`)
  - `taggables` (`tagId`, `entityType`, `entityId`)
- **Procedures to Build:**
  - `list`, `create`, `update`, `delete` (Cascades to taggables).
  - `apply` (Insert into taggables), `remove` (Delete from taggables).

## 7. Settings Domain (`settingsRouter`)
Thin user configuration.

- **Files to Create:**
  - `src/server/domain/settings/service.ts`
  - `src/server/trpc/routers/settings.ts`
- **DB Schema Addressed:** `userSettings`
  - Columns: `userId`, `schemaVersion`, `config`, `updatedAt`
- **Procedures to Build:**
  - `get`: Fetches config blob for `ctx.username` (via `users` join).
  - `update`: Validates and merges config blob.

## Global Wiring
To integrate these domains, I will:
1. Update `src/server/trpc/context.ts`'s `Services` interface to include `character`, `persona`, `worldInfo`, `tag`, and `settings`.
2. Update `src/server/index.ts` to instantiate these services and pass them into the context.
3. Update `src/server/trpc/router.ts` to mount the new sub-routers.

---

# Phase 2: AST-Based Macro Engine

Currently, `neo-tavern` relies on simple Regex substitution (`text.replace(/\{\{(\w+)\}\}/g)`) in `src/shared/prompt-assemble.ts` for basic noun replacements like `{{user}}` and `{{char}}`. 

While Regex is fast and fine for simple nouns, expanding to SillyTavern's full macro feature set (nested variables, slash commands, logic conditionals, and piped functions) will cause Regex to collapse into a brittle, unmaintainable mess. To handle this properly, we will build a true **Abstract Syntax Tree (AST)** parser.

## Why AST?
1. **Context Awareness:** Regex doesn't understand nesting. If you write `{{random:{{user}}_weapon}}`, Regex struggles to resolve the inner `{{user}}` before the outer `{{random:...}}`. An AST natively understands tree hierarchies.
2. **Logic & Conditionals:** Supporting `{{#if X}}...{{/if}}` requires tracking open/close states. AST parsers handle scope block resolution flawlessly.
3. **Maintainability:** Instead of 50 incomprehensible Regex strings, an AST separates the process into discrete, testable steps (Tokenization → Parsing → Evaluation).

## Architecture of the Macro Engine

The engine will be built in `src/shared/macro/` so that both the backend (for prompt assembly) and the frontend (for live UI preview) can use it.

### Step 1: The Lexer (Tokenizer)
The Lexer's job is to read the raw string character-by-character and convert it into a flat array of **Tokens**.
- `Raw String:` `"Hello {{user}}, use /roll 20"`
- `Tokens:`
  1. `Literal("Hello ")`
  2. `MacroOpen("{ {")`
  3. `Identifier("user")`
  4. `MacroClose("} }")`
  5. `Literal(", use ")`
  6. `Command("/roll", ["20"])`

### Step 2: The Parser (AST Builder)
The Parser loops through the flat Tokens and builds a hierarchical **Tree**.
It handles matching open brackets to close brackets and grouping arguments.
```json
{
  "type": "Root",
  "children": [
    { "type": "Text", "value": "Hello " },
    { "type": "Variable", "name": "user" },
    { "type": "Text", "value": ", use " },
    { "type": "SlashCommand", "name": "roll", "args": ["20"] }
  ]
}
```

### Step 3: The Evaluator (Renderer)
The Evaluator walks the AST recursively. When it encounters a `Variable` node, it looks up the value in a provided `Context` dictionary. When it hits a `SlashCommand`, it executes the registered function.
- It is purely synchronous and isolated, making it incredibly easy to unit test (e.g., `expect(evaluate(ast, { user: "Bob" })).toBe("Hello Bob...")`).

## Implementation Guide

When we are ready to replace the regex in `prompt-assemble.ts`:

1. **Create the AST Types (`src/shared/macro/types.ts`)**: Define the AST node interfaces (`TextNode`, `VarNode`, `IfNode`, `MacroCommandNode`).
2. **Write a Recursive Descent Parser**: No need for heavy external libraries like ANTLR or peg.js. A handwritten recursive descent parser (a simple `parse(tokens)` function that calls `parseMacro()` or `parseLiteral()`) is fast, dependency-free, and perfectly suited for this.
3. **Migrate `prompt-assemble.ts`**: Replace the `renderMacros` function with a call to `MacroEngine.render(text, { char: character.name, user: persona.name })`.
4. **Implement ST Compatibility**: Once the AST foundation is in, implementing SillyTavern's wilder macros (like `{{lastMessageId}}` or `{{#if}}`) becomes trivial because you just add a new Node type to the Evaluator, rather than rewriting a monolithic Regex.
