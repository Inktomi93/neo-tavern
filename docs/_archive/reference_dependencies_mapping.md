# Reference Dependencies Mapping

A deep-dive analysis of the frontend dependencies in our three reference projects (`SillyTavern`, `AstraProjecta`, and `Marinara-Engine`) and their modern React/Vite equivalents for `neo-tavern`.

## 1. Markdown Rendering & Sanitization
* **SillyTavern**: `showdown`, `dompurify`, `html-entities`
* **AstraProjecta**: `markdown-it`
* **Marinara-Engine**: `dompurify`
* **Modern Equivalent**: `react-markdown` + `remark-gfm` + `rehype-sanitize` (React-idiomatic, prevents raw HTML issues).
* **Action**: Currently in `docs/dependencies.md` parking lot. Ready to be installed when the Chat UI is built.

## 2. Tokenization & Text Processing
* **SillyTavern**: `@agnai/sentencepiece-js`, `@agnai/web-tokenizers`, `tiktoken` (JS-based, slow).
* **AstraProjecta / Marinara-Engine**: Not explicitly handled on the client in the same way.
* **Modern Equivalent**: `@anush008/tokenizers` (Native Rust tokenizer, prevents quadratic time complexity).
* **Action**: **Already installed** on the backend for the RAG and token counting pipelines.

## 3. UI Components & Styling
* **SillyTavern**: jQuery, `slidetoggle`, `@popperjs/core`
* **AstraProjecta**: `@radix-ui/*`, `vaul`, `tailwindcss`, `lucide-react`, `@tabler/icons`, `clsx`, `tailwind-merge`
* **Marinara-Engine**: `tailwindcss`, `framer-motion`, `lucide-react`, `sonner`, `clsx`, `tailwind-merge`
* **Modern Equivalent**: `shadcn` (includes Radix UI primitives), `tailwindcss v4`, `lucide-react`, `tw-animate-css` (replaces `framer-motion` / `tailwindcss-animate`), and `sonner`.
* **Action**: Currently in `docs/dependencies.md` parking lot. Ready to be installed with `shadcn init`. (Note: `@tabler/icons` and `vaul` are explicitly skipped per `docs/dependencies.md`).

## 4. State Management & Forms
* **SillyTavern**: DOM state, custom globals.
* **AstraProjecta / Marinara-Engine**: `zustand` (Marinara), custom contexts.
* **Modern Equivalent**: `zustand` (for global ephemeral state) and `react-hook-form` + `@hookform/resolvers` (for form validation with `zod`).
* **Action**: Currently in `docs/dependencies.md` parking lot. Only install when a feature actually requires true global state to avoid `knip` dead dependency errors.

## 5. Data Persistence & Local Storage
* **SillyTavern**: `localforage`, `node-persist`
* **AstraProjecta / Marinara-Engine**: Client cache APIs, `react-query`
* **Modern Equivalent**: Stateless client relying on TanStack Query (`@tanstack/react-query`). The backend `hono` server uses `drizzle-orm` + `@libsql/client` as the absolute source of truth.
* **Action**: **Already installed** and strictly enforced.

## 6. Code & Prompt Editors
* **SillyTavern**: `chevrotain`, `highlight.js`
* **AstraProjecta**: `@codemirror/state`, `@codemirror/view`, etc.
* **Marinara-Engine**: Standard textareas / undefined in dependencies.
* **Modern Equivalent**: `@uiw/react-codemirror` and `@codemirror/*` family.
* **Action**: Currently in `docs/dependencies.md` parking lot. Slated for the character card and prompt editors.

## 7. Fuzzy Search & Vector RAG
* **SillyTavern**: `fuse.js`, `vectra`
* **Modern Equivalent**: `BGE-M3` + `onnx-community/bge-reranker-v2-m3-ONNX` (in-process via `onnxruntime-node`) + `libsql_vector_idx` (`F32_BLOB`). 
* **Action**: **Already installed** and active on the backend. No fuzzy search needed on the client.

## 8. Translation APIs
* **SillyTavern**: `bing-translate-api`, `google-translate-api-x`
* **Modern Equivalent**: None.
* **Action**: **Out of scope** (slop). As per `CLAUDE.md`, this is a private, single-user RP frontend. On-the-fly UI translation is not part of the mission and should not be built.

## 9. Git Backups
* **SillyTavern**: `isomorphic-git`, `simple-git`
* **Modern Equivalent**: None.
* **Action**: **Out of scope**. `neo-tavern` uses SQLite as the canonical truth and standard database backup strategies, avoiding file-system based chat persistence.

## 10. Image & Asset Processing
* **SillyTavern**: `@jimp/core`, `image-size`, `png-chunk-text`, `png-chunks-extract`
* **Modern Equivalent**: `atomically` for CAS (Content-Addressed Storage) on the backend.
* **Action**: `atomically` is **already installed**. Character Card import logic (Phase 4) is deferred, so we will not add PNG chunk parsers to `docs/dependencies.md` until the import endpoint is actively being written.
