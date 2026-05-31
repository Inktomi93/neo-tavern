import { processMacros } from "./macro";
import type { PromptConfig, PromptSection, WorldInfoScope } from "./prompt-config";
import type { RegexPlacement } from "./regex";

// Pure prompt assembly: render a versioned PromptConfig against a chat's resolved data into the
// STATIC + DYNAMIC system-prompt halves (split at the config's boundary section). No DB, no infra
// — the caller (domain/chat) loads the context and passes it in, which keeps this unit-testable
// and reusable by raw mode + a client preview. sdk-mode passes the result as `systemPrompt`; chat
// history is NOT assembled here (it lives in the resumed session).
//
// {{user}} resolves DIFFERENTLY by section origin — the native "persona pin" done right:
//  • CARD-derived sections (char_*, post_history, a character's lorebook entries) use the PINNED
//    persona (the one the chat opened with), so switching persona mid-chat never retroactively
//    rewrites the card's references to {{user}}.
//  • USER-authored sections (literal blocks, the persona marker, chat-attached world-info) use the
//    CURRENT ACTIVE persona, so your own framing follows who you're playing now.
// (The pin is chats.pinnedPersonaId (migration 0017); chats.personaId is the active persona. They're
//  equal at open today and diverge once the active-persona-switch API — frontend — lands.)

export interface AssembleCharacter {
  name: string;
  description: string;
  personality?: string | null;
  scenario?: string | null;
  exampleMessages?: string | null;
  /** The card's own system-prompt override (char_system marker). */
  systemPrompt?: string | null;
  /** Post-history instructions / "jailbreak" (post_history marker). */
  postHistoryInstructions?: string | null;
}

export interface AssemblePersona {
  name: string;
  description: string;
}

export interface AssembleWorldEntry {
  content: string;
  scope: WorldInfoScope;
  keys: string[];
  priority: number;
  enabled: boolean;
  /** Where this entry is attached — "character" entries are card-derived (pinned persona),
   *  "chat" entries are user-attached (active persona). */
  source: "character" | "chat";
}

export interface AssembleContext {
  character: AssembleCharacter;
  /** {{user}} in CARD-derived sections — the chat-open ("pinned") persona. */
  pinnedPersona?: AssemblePersona | null;
  /** {{user}} in USER-authored sections — the chat's current active persona. */
  activePersona?: AssemblePersona | null;
  /** Attached world-info entries (the explicit pool); the marker filters by scope. */
  worldEntries: AssembleWorldEntry[];
  /** Recent message texts, for keyword-WI matching. */
  recentMessages: string[];
  /** Conversation-derived macro inputs ({{input}}/{{lastMessage}}/…). Optional — absent on paths
   *  that don't have them (macros then resolve to ""). */
  currentInput?: string | undefined;
  lastMessage?: string | undefined;
  lastUserMessage?: string | undefined;
  lastCharMessage?: string | undefined;
  /** IANA timezone for {{time}}/{{date}} — threaded from the request (browser zone). Absent → server-local. */
  timezone?: string | undefined;
  /** The chat's compaction summary, when in a mode that injects it (the stateless openrouter path).
   *  Rendered by the {{compact_summary}} marker; null/absent → nothing rendered. */
  compactSummary?: string | null;
  /** Retrieved chat-history memory (the {{memory}} marker) — relevant OLDER messages, pre-formatted
   *  by domain/chat's RAG (the ST `vectors` model). The marker wraps it; null/absent → nothing. */
  memory?: string | null;
}

// Metadata about what assembly did — for debug visibility (NOT the prompt text). The caller
// logs this so "why did/didn't this fire?" is answerable without dumping RP content.
export interface AssembleTrace {
  /** Section ids that rendered non-empty, in order, per half. */
  staticSections: string[];
  dynamicSections: string[];
  /** Count of world-info entries included (always + keyword-matched). */
  worldInfoIncluded: number;
  /** The trigger keys that fired keyword entries — answers "why did this lore appear". */
  matchedKeys: string[];
  /** True when the {{compact_summary}} marker rendered the chat's summary — the signal the caller
   *  uses to "pick up from the compaction point" (rebuild history from seq > compactedAtSeq). */
  compactSummaryIncluded: boolean;
  /** True when the {{memory}} marker rendered retrieved chat-history memory. */
  memoryIncluded: boolean;
  /** Volatile macro names ({{random}}, {{date}}, ...) found in source templates that landed in
   *  the STATIC half — these bust prompt cache every turn (the static half is the cached prefix).
   *  Empty in the well-formed case; non-empty = the caller should log a warning. */
  staticCacheBusters: string[];
}

export interface AssembledPrompt {
  /** Before the boundary — cache-stable (character/persona/always-WI/main). */
  static: string;
  /** After the boundary — re-evaluated per turn (keyword-WI, later: retrieved memory). */
  dynamic: string;
  /** Debug breakdown of what was included (metadata only). */
  trace: AssembleTrace;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Macros whose value changes per call → bust the cached static prefix every turn. The set is
// curated (not auto-derived) so static-prompt-safe macros ({{char}}, {{user}}, {{persona}}, ...)
// stay silent. Kept in sync with shared/macro/registry.ts.
const VOLATILE_MACRO_NAMES = [
  "random",
  "pick",
  "roll",
  "time",
  "date",
  "input",
  "lastMessage",
  "lastUserMessage",
  "lastCharMessage",
] as const;
const VOLATILE_MACRO_RE = new RegExp(`\\{\\{#?(${VOLATILE_MACRO_NAMES.join("|")})\\b`, "g");

// Source-template scan (NOT a post-render scan — macros are resolved before we'd see them).
// Returns the volatile macro names present in `text`, or [] if none.
function findVolatileMacros(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const m of text.matchAll(VOLATILE_MACRO_RE)) {
    if (m[1]) hits.add(m[1]);
  }
  return [...hits];
}

// Resolve {{macros}} against the character + the section-appropriate persona (pinned or active).
function renderMacros(
  text: string,
  ctx: AssembleContext,
  persona: AssemblePersona | null | undefined,
): string {
  return processMacros(text, {
    char: ctx.character.name,
    user: persona?.name ?? "User",
    persona: persona?.description ?? "",
    scenario: ctx.character.scenario ?? "",
    // Conversation-derived inputs for {{input}}/{{lastMessage}}/… (undefined → "" in the macro).
    input: ctx.currentInput,
    lastMessage: ctx.lastMessage,
    lastUserMessage: ctx.lastUserMessage,
    lastCharMessage: ctx.lastCharMessage,
    timezone: ctx.timezone,
    env: {},
  });
}

// Render the world-info entries of one scope, recording activation into the trace. Basic keyword
// match: any key whole-word present (case-insensitive) in recent messages. Deliberately simple —
// no secondary keys / AND-NOT logic / recursion (see CLAUDE.md World Info).
function renderWorldInfo(
  ctx: AssembleContext,
  scope: WorldInfoScope,
  trace: AssembleTrace,
  executeRegex?: (text: string, placement: RegexPlacement) => string,
): string {
  const haystack = ctx.recentMessages.join("\n").toLocaleLowerCase();
  const active: AssembleWorldEntry[] = [];
  for (const entry of ctx.worldEntries) {
    if (!entry.enabled || entry.scope !== scope) {
      continue;
    }
    if (scope === "keyword") {
      const hits = entry.keys
        .map((key) => key.trim().toLocaleLowerCase())
        // Unicode-aware "whole word" boundaries: JS \b is ASCII-only, so `café`, `北京`, and
        // keys ending in punctuation like `dr.` silently never match. Lookarounds against
        // letter/number/_ with the /u flag handle every script + lets punct-edged keys match.
        .filter(
          (key) =>
            key.length > 0 &&
            new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(key)}(?![\\p{L}\\p{N}_])`, "u").test(
              haystack,
            ),
        );
      if (hits.length === 0) {
        continue;
      }
      trace.matchedKeys.push(...hits);
    }
    active.push(entry);
  }
  active.sort((a, b) => b.priority - a.priority); // higher priority first
  trace.worldInfoIncluded += active.length;
  // character-attached entries are card-derived (pinned persona); chat-attached use active.
  return active
    .map((entry) => {
      let content = entry.content;
      if (executeRegex) {
        content = executeRegex(content, "WORLD_INFO");
      }
      return renderMacros(
        content,
        ctx,
        entry.source === "character" ? ctx.pinnedPersona : ctx.activePersona,
      );
    })
    .join("\n");
}

type MarkerSection = Extract<PromptSection, { type: "marker" }>;

function renderMarker(
  section: MarkerSection,
  ctx: AssembleContext,
  trace: AssembleTrace,
  executeRegex?: (text: string, placement: RegexPlacement) => string,
): string {
  const character = ctx.character;
  const pinned = ctx.pinnedPersona; // card-derived sections
  switch (section.marker) {
    case "char_description":
      return renderMacros(`${character.name}'s description: ${character.description}`, ctx, pinned);
    case "char_personality":
      return character.personality
        ? renderMacros(`${character.name}'s personality: ${character.personality}`, ctx, pinned)
        : "";
    case "scenario":
      return character.scenario ? renderMacros(`Scenario: ${character.scenario}`, ctx, pinned) : "";
    case "dialogue_examples":
      return character.exampleMessages
        ? renderMacros(`Example dialogue:\n${character.exampleMessages}`, ctx, pinned)
        : "";
    case "char_system":
      return character.systemPrompt ? renderMacros(character.systemPrompt, ctx, pinned) : "";
    case "post_history":
      return character.postHistoryInstructions
        ? renderMacros(character.postHistoryInstructions, ctx, pinned)
        : "";
    // The persona marker describes the CURRENT user identity → active persona.
    case "persona":
      return ctx.activePersona
        ? renderMacros(
            `${ctx.activePersona.name}: ${ctx.activePersona.description}`,
            ctx,
            ctx.activePersona,
          )
        : "";
    case "world_info":
      return renderWorldInfo(ctx, section.scope ?? "always", trace, executeRegex);
    // The compaction summary stands in for the compacted-away turns (stateless openrouter path).
    // Records into the trace so the caller knows to rebuild history from the compaction anchor.
    case "compact_summary": {
      const summary = ctx.compactSummary?.trim();
      if (!summary) {
        return "";
      }
      trace.compactSummaryIncluded = true;
      return `Summary of the conversation so far:\n${summary}`;
    }
    // Retrieved chat-history memory (the ST `vectors` model) — relevant OLDER messages the caller
    // (domain/chat) fetched + formatted. Placeable anywhere; lives in the dynamic half by default
    // (cache-safe). Empty when memory is off / nothing retrieved.
    case "memory": {
      const mem = ctx.memory?.trim();
      if (!mem) {
        return "";
      }
      trace.memoryIncluded = true;
      return `Past events:\n${mem}`;
    }
    // sdk-mode: live history lives in the resumed session, so chat_history renders empty here
    // (raw mode rebuilds it from canon outside assembly).
    case "chat_history":
      return "";
  }
}

// Source-template strings (pre-macro-resolution) that feed a given section. Only used by the
// volatile-macro detector — order/dedup don't matter, just coverage of every place a user can put
// {{date}}/{{random}}/etc. (Empty for `chat_history` since live history isn't rendered here.)
function collectStaticSources(section: PromptSection, ctx: AssembleContext): string[] {
  if (section.type === "boundary") return [];
  if (section.type === "literal") return [section.content];
  // markers
  switch (section.marker) {
    case "char_description":
      return [ctx.character.description ?? ""];
    case "char_personality":
      return [ctx.character.personality ?? ""];
    case "scenario":
      return [ctx.character.scenario ?? ""];
    case "dialogue_examples":
      return [ctx.character.exampleMessages ?? ""];
    case "char_system":
      return [ctx.character.systemPrompt ?? ""];
    case "post_history":
      return [ctx.character.postHistoryInstructions ?? ""];
    case "persona":
      return ctx.activePersona ? [ctx.activePersona.description] : [];
    case "world_info": {
      const scope = section.scope ?? "always";
      return ctx.worldEntries.filter((e) => e.enabled && e.scope === scope).map((e) => e.content);
    }
    default:
      return [];
  }
}

function renderSection(
  section: PromptSection,
  ctx: AssembleContext,
  trace: AssembleTrace,
  executeRegex?: (text: string, placement: RegexPlacement) => string,
): string {
  switch (section.type) {
    case "boundary":
      return "";
    // Literal blocks are USER-authored → active persona.
    case "literal":
      return renderMacros(section.content, ctx, ctx.activePersona);
    case "marker":
      return renderMarker(section, ctx, trace, executeRegex);
  }
}

/**
 * Render `config` against `ctx` into the static + dynamic system-prompt halves. Sections are
 * walked in order; the (optional, at-most-one) boundary section flips the accumulator from
 * static to dynamic. Disabled sections and empty renders are skipped.
 */
export function assemblePrompt(
  config: PromptConfig,
  ctx: AssembleContext,
  executeRegex?: (text: string, placement: RegexPlacement) => string,
): AssembledPrompt {
  const staticParts: string[] = [];
  const dynamicParts: string[] = [];
  const trace: AssembleTrace = {
    staticSections: [],
    dynamicSections: [],
    worldInfoIncluded: 0,
    matchedKeys: [],
    compactSummaryIncluded: false,
    memoryIncluded: false,
    staticCacheBusters: [],
  };
  let bucket = staticParts;
  let bucketSections = trace.staticSections;
  let inStatic = true;
  const cacheBusters = new Set<string>();

  for (const section of config.sections) {
    if (section.type === "boundary") {
      bucket = dynamicParts;
      bucketSections = trace.dynamicSections;
      inStatic = false;
      continue;
    }
    if (!section.enabled) {
      continue;
    }
    if (inStatic) {
      // Pre-render source-template scan: macros get resolved before they hit `static`, so a
      // post-render check is impossible. Walk only the strings that could carry a {{macro}}.
      for (const src of collectStaticSources(section, ctx)) {
        for (const name of findVolatileMacros(src)) cacheBusters.add(name);
      }
    }
    const rendered = renderSection(section, ctx, trace, executeRegex).trim();
    if (rendered.length > 0) {
      bucket.push(rendered);
      bucketSections.push(section.id);
    }
  }
  trace.staticCacheBusters = [...cacheBusters];

  return {
    static: staticParts.join("\n\n"),
    dynamic: dynamicParts.join("\n\n"),
    trace,
  };
}
