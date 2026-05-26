import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { Db } from "../../src/db/client";
import { chats, messages } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { createChatService } from "../../src/server/domain/chat";
import { createPresetService } from "../../src/server/domain/preset";
import type { Embedder } from "../../src/server/embeddings/embedder";
import { DEFAULT_PROMPT_CONFIG, type PromptConfig } from "../../src/shared/prompt-config";
import { freshDb } from "../support/db";

// Bag-of-words fake embedder: each word → a dim, summed + L2-normalized. So texts that SHARE words
// land near each other (cosine ∝ overlap) — enough to exercise the retrieval pipeline deterministically
// without the real BGE-M3 model (no GPU in `pnpm check`).
const VOCAB = new Map<string, number>();
function bow(text: string): Float32Array {
  const v = new Float32Array(1024);
  for (const w of text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    let d = VOCAB.get(w);
    if (d === undefined) {
      d = (VOCAB.size + 1) % 1024;
      VOCAB.set(w, d);
    }
    v[d] = (v[d] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}
const fakeEmbedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(bow(t)),
  embedBatch: (ts) => Promise.resolve(ts.map(bow)),
};

async function insertMessages(
  db: Db,
  chatId: string,
  msgs: { role: "user" | "assistant"; content: string }[],
): Promise<void> {
  const now = Date.now();
  for (const [i, m] of msgs.entries()) {
    await db
      .insert(messages)
      .values({ id: newId(), chatId, seq: i, role: m.role, content: m.content, createdAt: now });
  }
}

// seq1 (assistant) is the relevant OLD memory; the latest message (the query) shares its keywords;
// seq2..6 are the protected recent window (protect=5).
const SCRIPT: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "good morning my friend" },
  {
    role: "assistant",
    content:
      "I am Vermithrax, an ancient dragon who guards the northern mountain pass and hoards emeralds",
  },
  { role: "user", content: "interesting" },
  { role: "assistant", content: "indeed it is" },
  { role: "user", content: "what shall we do" },
  { role: "assistant", content: "we rest by the fire" },
  { role: "user", content: "remind me — what does the ancient dragon guard in the northern pass?" },
];

async function setup(memoryEnabled: boolean): Promise<{
  db: Db;
  chatId: string;
  preview: () => Promise<{ static: string; dynamic: string }>;
}> {
  const db = await freshDb();
  const chat = createChatService(db, { embedder: fakeEmbedder });
  const preset = createPresetService(db);
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "a dragon",
  });
  await insertMessages(db, chatId, SCRIPT);

  const config: PromptConfig = {
    ...DEFAULT_PROMPT_CONFIG,
    params: memoryEnabled
      ? { memory: { enabled: true, queryMessages: 2, insert: 3, protect: 5, minScore: 0.25 } }
      : {},
  };
  const p = await preset.create({ username: "owner", name: "mem", kind: "chat", config });
  if (p.currentVersionId === null) throw new Error("expected a preset version");
  await db.update(chats).set({ presetVersionId: p.currentVersionId }).where(eq(chats.id, chatId));

  const preview = async () =>
    (await chat.previewAssembly({ username: "owner", chatId })).systemPrompt;
  return { db, chatId, preview };
}

test("memory ON: retrieves the relevant OLD message into the dynamic half, excludes the protected window", async () => {
  const { preview } = await setup(true);
  const { dynamic } = await preview();

  expect(dynamic).toContain("Past events:"); // the {{memory}} marker rendered
  expect(dynamic).toContain("I am Vermithrax, an ancient dragon"); // seq1 — keyword-relevant, retrieved
  // seq0 ("good morning") shares no keywords with the query → below threshold, not retrieved
  expect(dynamic).not.toContain("good morning my friend");
  // seq5 ("we rest by the fire") is in the PROTECTED recent window → never a memory candidate
  expect(dynamic).not.toContain("we rest by the fire");
});

test("memory OFF (default params): nothing is retrieved — no Past events block", async () => {
  const { preview } = await setup(false);
  const { static: staticHalf, dynamic } = await preview();
  expect(staticHalf).not.toContain("Past events:");
  expect(dynamic).not.toContain("Past events:");
  expect(dynamic).not.toContain("I am Vermithrax, an ancient dragon");
});
