import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { characterEmbeddings } from "../../../db/schema";
import type { Summarizer } from "../../embeddings/summarizer";

// LLM card analysis (card-curator analyze.py) — the RICH versions that the cheap distill-facet diffs
// can't give: a prose comparison + verdict, and arbitrary Q&A over a card. Grammar-constrained output
// (same mechanism as DIGEST_SCHEMA). Live (1 summarizer call); the warm model is shared, so cheap.

const MAX_CARD = 5000;

// camelCase keys (the grammar constrains whatever keys we declare; avoids the snake_case lint).
export const COMPARISON_SCHEMA = {
  type: "object",
  properties: {
    similarities: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 6 },
    differences: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 6 },
    redundancyScore: { type: "number" },
    verdict: { type: "string" },
  },
  required: ["similarities", "differences", "redundancyScore", "verdict"],
};

export const ASK_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

const COMPARE_SYSTEM = `You compare two roleplay character cards. Output ONLY a JSON object of this exact shape (no prose, no markdown, no <think>):
{"similarities":["..."],"differences":["..."],"redundancyScore":0.0,"verdict":"..."}
- similarities: 0-6 concrete things the two share (premise, dynamic, tropes).
- differences: 0-6 concrete things that set them apart.
- redundancyScore: 0.0-1.0 — how redundant keeping BOTH is (1.0 = near-identical, drop one).
- verdict: one sentence — keep both, merge, or which to prefer and why.`;

const ASK_SYSTEM = `You answer a question about a roleplay character card using ONLY what the card supports. Output ONLY a JSON object: {"answer":"..."}. If the card doesn't say, answer "The card doesn't specify." Be concrete and brief.`;

async function cardText(db: Db, ownerId: string, characterId: string): Promise<string | null> {
  const rows = await db
    .select({ sourceText: characterEmbeddings.sourceText })
    .from(characterEmbeddings)
    .where(
      and(
        eq(characterEmbeddings.characterId, characterId),
        eq(characterEmbeddings.ownerId, ownerId),
      ),
    )
    .limit(1);
  const t = rows[0]?.sourceText;
  return t ? t.slice(0, MAX_CARD) : null;
}

export interface DeepComparison {
  similarities: string[];
  differences: string[];
  redundancyScore: number;
  verdict: string;
}

/** LLM comparison of two cards → similarities/differences/redundancy/verdict (card-curator compare_cards). */
export async function compareCharactersDeep(
  db: Db,
  ownerId: string,
  summarizer: Summarizer,
  idA: string,
  idB: string,
): Promise<DeepComparison | null> {
  const [a, b] = await Promise.all([cardText(db, ownerId, idA), cardText(db, ownerId, idB)]);
  if (!a || !b) return null;
  const res = await summarizer.summarize(
    COMPARE_SYSTEM,
    `Card A:\n${a}\n\nCard B:\n${b}\n\nCompare them:`,
    { jsonSchema: COMPARISON_SCHEMA, maxTokens: 512, temperature: 0.3 },
  );
  const o = sliceJson(res.text) as {
    similarities?: unknown;
    differences?: unknown;
    redundancyScore?: unknown;
    verdict?: unknown;
  } | null;
  if (!o) return null;
  return {
    similarities: strArr(o.similarities),
    differences: strArr(o.differences),
    redundancyScore: typeof o.redundancyScore === "number" ? o.redundancyScore : 0,
    verdict: typeof o.verdict === "string" ? o.verdict : "",
  };
}

/** Grammar-constrained Q&A over one card (card-curator ask_about_card). */
export async function askCard(
  db: Db,
  ownerId: string,
  summarizer: Summarizer,
  characterId: string,
  question: string,
): Promise<{ answer: string } | null> {
  const card = await cardText(db, ownerId, characterId);
  if (!card) return null;
  const res = await summarizer.summarize(ASK_SYSTEM, `Card:\n${card}\n\nQuestion: ${question}`, {
    jsonSchema: ASK_SCHEMA,
    maxTokens: 384,
    temperature: 0.2,
  });
  const o = sliceJson(res.text) as { answer?: unknown } | null;
  return { answer: o && typeof o.answer === "string" ? o.answer : "The card doesn't specify." };
}

function sliceJson(raw: string): unknown {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const v: unknown = JSON.parse(raw.slice(s, e + 1));
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
