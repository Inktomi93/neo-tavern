import { desc, eq } from "drizzle-orm";
import type { Db } from "../../../../db/client";
import {
  characterVersions,
  characterVersionWorldEntries,
  type chats,
  chatWorldEntries,
  messages,
  personas,
  presetVersions,
  worldEntries,
} from "../../../../db/schema";
import type {
  AssembleContext,
  AssemblePersona,
  AssembleWorldEntry,
} from "../../../../shared/prompt-assemble";
import {
  DEFAULT_PROMPT_CONFIG,
  type PromptConfig,
  parsePromptConfig,
  type WorldInfoScope,
} from "../../../../shared/prompt-config";
import type { Embedder } from "../../../embeddings/embedder";
import type { Reranker } from "../../../embeddings/reranker";
import { retrieveMemory } from "../memory/retrieve";

const RECENT_MESSAGE_WINDOW = 6;

export function toWorldEntry(
  row: {
    content: string;
    enabled: boolean | null;
    priority: number | null;
    legacyKeys: unknown;
    scope: string | null;
  },
  source: AssembleWorldEntry["source"],
): AssembleWorldEntry {
  const scope: WorldInfoScope = row.scope === "keyword" ? "keyword" : "always";
  const keys = Array.isArray(row.legacyKeys)
    ? row.legacyKeys.filter((k): k is string => typeof k === "string")
    : [];
  return {
    content: row.content,
    scope,
    keys,
    priority: row.priority ?? 0,
    enabled: row.enabled ?? true,
    source,
  };
}

export async function resolveConfig(
  db: Db,
  chat: typeof chats.$inferSelect,
): Promise<PromptConfig> {
  if (chat.presetVersionId === null) {
    return DEFAULT_PROMPT_CONFIG;
  }
  const rows = await db
    .select({ config: presetVersions.config })
    .from(presetVersions)
    .where(eq(presetVersions.id, chat.presetVersionId))
    .limit(1);
  const raw = rows[0]?.config;
  return raw === undefined ? DEFAULT_PROMPT_CONFIG : parsePromptConfig(raw);
}

export async function buildAssembleContext(
  db: Db,
  embedder: Embedder,
  reranker: Reranker,
  chat: typeof chats.$inferSelect,
  // `send` defers memory retrieval to AFTER it appends the regex-processed in-flight user turn, so
  // the query reflects the message being answered (it can't reorder the insert — the stored content
  // depends on macroCtx → this context). Other callers (swipe/read/compaction) have no in-flight
  // turn, so they retrieve inline against committed rows here.
  opts: { deferMemory?: boolean } = {},
): Promise<AssembleContext> {
  const cvRows = await db
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.id, chat.characterVersionId))
    .limit(1);
  const cv = cvRows[0];

  const loadPersona = async (id: string | null): Promise<AssemblePersona | null> => {
    if (id === null) return null;
    const rows = await db
      .select({ name: personas.name, description: personas.description })
      .from(personas)
      .where(eq(personas.id, id))
      .limit(1);
    return rows[0] ?? null;
  };
  const activePersona = await loadPersona(chat.personaId);
  const pinnedPersona =
    chat.pinnedPersonaId === null ? activePersona : await loadPersona(chat.pinnedPersonaId);

  const wiSelect = {
    content: worldEntries.content,
    enabled: worldEntries.enabled,
    priority: worldEntries.priority,
    legacyKeys: worldEntries.legacyKeys,
  };
  const chatWi = await db
    .select({ ...wiSelect, scope: chatWorldEntries.scope })
    .from(chatWorldEntries)
    .innerJoin(worldEntries, eq(chatWorldEntries.entryId, worldEntries.id))
    .where(eq(chatWorldEntries.chatId, chat.id));
  const cvWi = await db
    .select({ ...wiSelect, scope: characterVersionWorldEntries.scope })
    .from(characterVersionWorldEntries)
    .innerJoin(worldEntries, eq(characterVersionWorldEntries.entryId, worldEntries.id))
    .where(eq(characterVersionWorldEntries.characterVersionId, chat.characterVersionId));

  const recent = await db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.chatId, chat.id))
    .orderBy(desc(messages.seq))
    .limit(RECENT_MESSAGE_WINDOW);

  let memory: string | null = null;
  const config = await resolveConfig(db, chat);
  const memCfg = config.params.memory;
  const hasMemoryMarker = config.sections.some(
    (s) => s.type === "marker" && s.marker === "memory" && s.enabled,
  );
  if (!opts.deferMemory && memCfg?.enabled === true && hasMemoryMarker) {
    memory = await retrieveMemory(db, { embedder, reranker }, { chatId: chat.id, params: memCfg });
  }

  return {
    character: cv
      ? {
          name: cv.name,
          description: cv.description,
          personality: cv.personality,
          scenario: cv.scenario,
          exampleMessages: cv.exampleMessages,
          systemPrompt: cv.systemPrompt,
          postHistoryInstructions: cv.postHistoryInstructions,
        }
      : { name: "Assistant", description: "" },
    pinnedPersona,
    activePersona,
    worldEntries: [
      ...chatWi.map((r) => toWorldEntry(r, "chat")),
      ...cvWi.map((r) => toWorldEntry(r, "character")),
    ],
    recentMessages: recent.map((r) => r.content).reverse(),
    compactSummary: chat.api === "agent-sdk" ? null : chat.compactSummary,
    memory,
  };
}
