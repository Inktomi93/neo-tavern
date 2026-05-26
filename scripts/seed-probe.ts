import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  type Options,
  query,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSdkEnv } from "../src/server/env";

/**
 * SEED-FROM-CANON probe (#39) — STOP CLAIMING, MEASURE. The compaction probe proved that
 * REPLAYING captured SDK frames resumes coherently. This asks the harder question: can we
 * SYNTHESIZE frames from plain canon (role + text only — what we'd have for an ST import or a
 * raw→sdk fork, with no promptId/requestId/cwd/timestamps) and have the model treat them as
 * real history? It tries shapes from MINIMAL upward and reports which recalls a seeded fact.
 *
 *   pnpm exec tsx scripts/seed-probe.ts
 * Auth: host `claude login` (Max sub).
 */

const MODEL = process.env["MODEL"] ?? "claude-haiku-4-5-20251001";

interface Canon {
  role: "user" | "assistant";
  text: string;
}

// The synthetic transcript we seed. Turn 1 plants a codeword; resume must recall it.
const CANON: Canon[] = [
  { role: "user", text: "Remember this exact codeword: PURPLE-HORIZON-7. Reply 'noted'." },
  { role: "assistant", text: "noted" },
];

function baseOptions(): Options {
  return {
    model: MODEL,
    maxTurns: 1,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    env: buildClaudeSdkEnv(),
  };
}

class SeededStore implements SessionStore {
  readonly added: SessionStoreEntry[] = [];
  private readonly seed: SessionStoreEntry[];
  constructor(seed: SessionStoreEntry[]) {
    this.seed = seed;
  }
  append(_key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.added.push(...entries);
    return Promise.resolve();
  }
  load(_key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return Promise.resolve([...this.seed, ...this.added]);
  }
  listSubkeys(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

type Shape =
  | "minimal"
  | "withMessageMeta"
  | "withScaffold"
  | "scaffoldNoLastPrompt" // isolate: is the last-prompt leafUuid bookmark the key?
  | "lastPromptOnly"; // isolate: is per-frame meta needed, or just the bookmark?

// Build frames from canon under a candidate shape. The parentUuid chain + valid uuids are
// constant across shapes; what varies is how much SDK bookkeeping we include.
function seedFrames(canon: Canon[], sessionId: string, shape: Shape): SessionStoreEntry[] {
  const frames: SessionStoreEntry[] = [];
  let parentUuid: string | null = null;
  const common = {
    isSidechain: false,
    cwd: "/",
    version: "2.0.0",
    sessionId,
    userType: "external",
  };
  const withMeta = shape === "withScaffold" || shape === "scaffoldNoLastPrompt";
  const richMessage = shape !== "minimal" && shape !== "lastPromptOnly";
  const withLastPrompt =
    shape === "withScaffold" || shape === "lastPromptOnly" || shape === "scaffoldNoLastPrompt"
      ? shape !== "scaffoldNoLastPrompt"
      : false;

  canon.forEach((m, i) => {
    const uuid = randomUUID();
    if (m.role === "user") {
      const base = {
        type: "user",
        uuid,
        parentUuid,
        message: { role: "user", content: [{ type: "text", text: m.text }] },
      };
      const scaffold = withMeta
        ? { ...common, promptId: randomUUID(), timestamp: new Date().toISOString() }
        : {};
      frames.push({ ...base, ...scaffold } as unknown as SessionStoreEntry);
    } else {
      const message = richMessage
        ? {
            role: "assistant",
            model: MODEL,
            id: `msg_seed_${i}`,
            type: "message",
            content: [{ type: "text", text: m.text }],
            stop_reason: "end_turn",
          }
        : { role: "assistant", content: [{ type: "text", text: m.text }] };
      const base = { type: "assistant", uuid, parentUuid, message };
      const scaffold = withMeta
        ? { ...common, requestId: `req_seed_${i}`, timestamp: new Date().toISOString() }
        : {};
      frames.push({ ...base, ...scaffold } as unknown as SessionStoreEntry);
    }
    parentUuid = uuid;
  });

  if (withLastPrompt) {
    frames.push({
      type: "last-prompt",
      lastPrompt: canon.at(-1)?.text ?? "",
      leafUuid: parentUuid,
      sessionId,
    } as unknown as SessionStoreEntry);
  }
  return frames;
}

async function resumeAndRecall(seed: SessionStoreEntry[], sessionId: string): Promise<string> {
  const store = new SeededStore(seed);
  let reply = "";
  for await (const message of query({
    prompt: "What was the exact codeword I gave you earlier? Reply with only it.",
    options: { ...baseOptions(), resume: sessionId, sessionStore: store },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          reply += block.text;
        }
      }
    }
  }
  return reply.trim();
}

async function recallWithSeed(
  seed: SessionStoreEntry[],
  sessionId: string,
  question: string,
  systemPrompt?: string,
): Promise<string> {
  const store = new SeededStore(seed);
  let reply = "";
  for await (const message of query({
    prompt: question,
    options: {
      ...baseOptions(),
      resume: sessionId,
      sessionStore: store,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          reply += block.text;
        }
      }
    }
  }
  return reply.trim();
}

// Greeting case: a chat opens with an assistant greeting and NO real user turn. KEY realization
// from the first failed run: without a CHARACTER system prompt + a NATURAL in-RP question, the
// model (as Claude) refuses to own a planted assistant message ("I shouldn't pretend I said…").
// Real greeting seeding always has the assembled character prompt. So test it properly: a character
// system prompt + the ST invisible-user prefix + a NATURAL recall (in-world, not "did you say X").
async function greetingCases(): Promise<void> {
  console.log(
    "\n══ GREETING (assistant-first) — invisible-user prefix + character system prompt ══",
  );
  const System =
    "You are Aria, the warm, witty keeper of the Gilded Griffin tavern. Stay fully in character; never break the fourth wall or mention being an AI.";
  // The greeting states an in-world detail the user can naturally ask back about.
  const Greeting =
    "*Aria looks up from polishing a glass and beams.* Welcome to the Gilded Griffin, traveler! Tonight's specialty is honeyed dragonfruit mead — care for a mug?";
  const Q = "Sure! Remind me — what's tonight's specialty again?";

  const variants: Record<string, Canon[]> = {
    "bare assistant-first": [{ role: "assistant", text: Greeting }],
    "invisible-user prefix": [
      { role: "user", text: "*enters the tavern*" },
      { role: "assistant", text: Greeting },
    ],
  };

  for (const [label, canon] of Object.entries(variants)) {
    const sessionId = randomUUID();
    const seed = seedFrames(canon, sessionId, "scaffoldNoLastPrompt");
    try {
      const reply = await recallWithSeed(seed, sessionId, Q, System);
      const inWorld = /dragonfruit|mead/i.test(reply);
      const refused = /\bAI\b|I shouldn't|I should clarify|I didn't actually|as an assistant/i.test(
        reply,
      );
      console.log(
        `  ${label.padEnd(24)} → owns-greeting ${inWorld && !refused ? "YES ✓" : "NO ✗"} (inWorld=${inWorld} refused=${refused})`,
      );
      console.log(`      reply: ${JSON.stringify(reply.slice(0, 110))}`);
    } catch (error) {
      console.log(
        `  ${label.padEnd(24)} → ERROR ${error instanceof Error ? error.message.slice(0, 60) : String(error)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(`Seed-from-canon probe — model=${MODEL}`);
  console.log(`canon: ${CANON.map((m) => `${m.role}:${JSON.stringify(m.text)}`).join("  ")}\n`);

  const shapes: Shape[] = [
    "minimal",
    "withMessageMeta",
    "withScaffold",
    "scaffoldNoLastPrompt",
    "lastPromptOnly",
  ];
  for (const shape of shapes) {
    const sessionId = randomUUID();
    const seed = seedFrames(CANON, sessionId, shape);
    try {
      const reply = await resumeAndRecall(seed, sessionId);
      const ok = reply.includes("PURPLE-HORIZON-7");
      console.log(
        `shape=${shape.padEnd(16)} → recall ${ok ? "YES ✓" : "NO ✗"}  reply=${JSON.stringify(reply.slice(0, 50))}`,
      );
    } catch (error) {
      console.log(
        `shape=${shape.padEnd(16)} → ERROR ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await greetingCases();
}

await main().catch((error: unknown) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
