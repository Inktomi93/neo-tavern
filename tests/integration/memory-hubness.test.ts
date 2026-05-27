import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { chatDigests, chatSegments, messages } from "../../src/db/schema";
import { newId } from "../../src/server/domain/_shared/ids";
import { createChatService } from "../../src/server/domain/chat";
import { generateDigests, generateSegments } from "../../src/server/domain/chat/memory";
import { computeDigestHubScores, computeSegmentHubScores } from "../../src/server/domain/corpus";
import type { Embedder } from "../../src/server/embeddings/embedder";
import type { Summarizer } from "../../src/server/embeddings/summarizer";
import { freshDb } from "../support/db";

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
const embedder: Embedder = {
  model: "fake",
  embed: (t) => Promise.resolve(bow(t)),
  embedBatch: (ts) => Promise.resolve(ts.map(bow)),
};
const summarizer: Summarizer = {
  summarize: (_s, user) =>
    Promise.resolve({ text: `[scene]\n- ${user.replace(/\s+/g, " ").trim()}`, model: "fake" }),
};

const SCRIPT: { role: "user" | "assistant"; content: string }[] = [
  { role: "user", content: "good morning friend" },
  { role: "assistant", content: "I am Vermithrax an ancient dragon guarding the northern pass" },
  { role: "user", content: "tell me about your emeralds" },
  { role: "assistant", content: "I hoard emeralds deep in my cavern" },
  { role: "user", content: "and the village nearby" },
  { role: "assistant", content: "the village pays tribute every winter" },
  { role: "user", content: "what of the knights" },
  { role: "assistant", content: "the knights fear my fire and keep their distance" },
];

test("CSLS hub scores are computed + stored on chat_digests and chat_segments", async () => {
  const db = await freshDb();
  const chat = createChatService(db, { embedder });
  const { chatId } = await chat.create({
    username: "owner",
    title: "t",
    characterName: "Vermithrax",
    characterDescription: "d",
  });
  const now = Date.now();
  for (const [i, m] of SCRIPT.entries()) {
    await db
      .insert(messages)
      .values({ id: newId(), chatId, seq: i, role: m.role, content: m.content, createdAt: now });
  }
  await generateSegments(db, { embedder }, { chatId, blockSize: 2 });
  await generateDigests(
    db,
    { embedder, summarizer },
    { chatId, params: { enabled: true, blockSize: 2, verbatimWindow: 2, mode: "mixA" } },
  );

  // Small k so the modest fixtures clear the k+1 group floor: 4 segments, 3 tier-0 digests.
  const segWritten = await computeSegmentHubScores(db, { k: 2 });
  const digWritten = await computeDigestHubScores(db, { k: 2 });
  expect(segWritten).toBe(4);
  expect(digWritten).toBe(3);

  const segs = await db.select().from(chatSegments).where(eq(chatSegments.chatId, chatId));
  const digs = await db.select().from(chatDigests).where(eq(chatDigests.chatId, chatId));
  expect(segs).toHaveLength(4);
  expect(digs).toHaveLength(3);
  expect(segs.every((s) => s.hubScore !== null)).toBe(true);
  expect(digs.every((d) => d.hubScore !== null)).toBe(true);
});
