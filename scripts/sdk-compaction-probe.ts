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
 * Compaction + mode-seeding probe — STOP CLAIMING, MEASURE. Answers, empirically:
 *   A. What frames does the SDK actually append to our SessionStore per turn?
 *      (the exact shape we'd have to seed for a raw→sdk fork / ST import)
 *   B. If we seed those frames into a FRESH store and resume, does the model treat
 *      them as real history? (the raw→sdk seeding claim)
 *   C. When a real compaction fires (forced via a tiny autoCompactWindow), what lands
 *      in the store, does a compact_boundary frame appear, do the OLD frames stay, and
 *      does resume-after-compaction still recall an early fact? (the "marker = start"
 *      claim + whether load() returning everything works)
 *
 *   pnpm exec tsx scripts/sdk-compaction-probe.ts            # phases A + B (cheap)
 *   COMPACT=1 pnpm exec tsx scripts/sdk-compaction-probe.ts  # + phase C (forces compaction)
 *   WINDOW=2000 COMPACT=1 ...                                # tune the forced-compaction window
 *
 * Auth: host `claude login` (Max sub), same as the real provider.
 */

const MODEL = process.env["MODEL"] ?? "claude-haiku-4-5-20251001";
const WINDOW = Number(process.env["WINDOW"] ?? "2000") || 2000;

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

// Records every appended frame in order, like the real DbSessionStore but in memory.
class RecordingStore implements SessionStore {
  readonly frames: SessionStoreEntry[] = [];
  appendCount = 0;

  append(_key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.appendCount += 1;
    this.frames.push(...entries);
    return Promise.resolve();
  }

  load(_key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return Promise.resolve(this.frames.length > 0 ? [...this.frames] : null);
  }

  listSubkeys(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

// A store preloaded with hand-/captured frames — the SEEDING simulation. load()
// returns the seed for the main key; append() records anything the SDK adds after.
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

interface TurnOut {
  sessionId: string;
  reply: string;
  streamTypes: string[];
  inputTokens: number;
  compactions: unknown[];
}

async function runTurn(prompt: string, extra: Partial<Options>): Promise<TurnOut> {
  const out: TurnOut = {
    sessionId: "",
    reply: "",
    streamTypes: [],
    inputTokens: 0,
    compactions: [],
  };
  for await (const message of query({ prompt, options: { ...baseOptions(), ...extra } })) {
    const tag = "subtype" in message ? `${message.type}/${String(message.subtype)}` : message.type;
    if (message.type !== "stream_event") {
      out.streamTypes.push(tag);
    }
    if ("session_id" in message && typeof message.session_id === "string") {
      out.sessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      out.compactions.push(message.compact_metadata);
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          out.reply += block.text;
        }
      }
    }
    if (message.type === "result") {
      for (const usage of Object.values(message.modelUsage)) {
        out.inputTokens += usage.inputTokens;
      }
    }
  }
  return out;
}

function frameSummary(frames: SessionStoreEntry[]): string {
  return frames
    .map((f, i) => `${i}:${f.type}${typeof f.uuid === "string" ? `(${f.uuid.slice(0, 8)})` : ""}`)
    .join(" ");
}

function short(value: unknown, n = 240): string {
  const j = JSON.stringify(value);
  return j.length <= n ? j : `${j.slice(0, n)}…`;
}

async function phaseA(): Promise<{ sessionId: string; frames: SessionStoreEntry[] }> {
  console.log("\n══ PHASE A — what frames does the SDK append per turn? ══");
  const store = new RecordingStore();
  const t1 = await runTurn(
    "Remember this exact codeword: PURPLE-HORIZON-7. Reply 'noted' and nothing else.",
    { sessionStore: store },
  );
  console.log(`turn 1 stream: [${t1.streamTypes.join(", ")}]  reply=${JSON.stringify(t1.reply)}`);
  const t2 = await runTurn("Reply 'ok' and nothing else.", {
    resume: t1.sessionId,
    sessionStore: store,
  });
  console.log(`turn 2 stream: [${t2.streamTypes.join(", ")}]  reply=${JSON.stringify(t2.reply)}`);
  console.log(
    `\nstore.append() called ${store.appendCount}×; ${store.frames.length} frames total:`,
  );
  console.log(`  types: [${frameSummary(store.frames)}]`);
  console.log("\nfull frame shapes (the seeding ground truth):");
  store.frames.forEach((f, i) => {
    console.log(`  [${i}] keys=${JSON.stringify(Object.keys(f))}`);
    console.log(`      ${short(f)}`);
  });
  return { sessionId: t1.sessionId, frames: store.frames };
}

async function phaseB(captured: { sessionId: string; frames: SessionStoreEntry[] }): Promise<void> {
  console.log("\n══ PHASE B — seed a FRESH session from captured frames, then resume ══");
  console.log("(if the model recalls the codeword, load()-seeding a session works)\n");
  // A brand-new VALID-UUID session the SDK has never seen — does it fall through to our
  // load()? (A non-UUID string was rejected outright.) Re-stamp the frames' internal
  // sessionId to this id in case the SDK cross-checks it.
  const seededId = randomUUID();
  const reStamped = JSON.parse(
    JSON.stringify(captured.frames).replaceAll(captured.sessionId, seededId),
  ) as SessionStoreEntry[];
  const store = new SeededStore(reStamped);
  const t = await runTurn("What was the exact codeword I gave you earlier? Reply with only it.", {
    resume: seededId,
    sessionStore: store,
  });
  console.log(`seeded resume stream: [${t.streamTypes.join(", ")}]`);
  console.log(`reply: ${JSON.stringify(t.reply)}`);
  console.log(`recalled codeword: ${t.reply.includes("PURPLE-HORIZON-7") ? "YES ✓" : "NO ✗"}`);
  console.log(`SDK appended ${store.added.length} new frames after the seed.`);
}

async function phaseC(): Promise<void> {
  console.log(`\n══ PHASE C — force a real compaction (autoCompactWindow=${WINDOW}) ══`);
  const store = new RecordingStore();
  const settings = { autoCompactWindow: WINDOW, autoCompactEnabled: true };
  let sessionId = "";
  let firstFact = "";
  let compactionSeen = false;

  for (let i = 1; i <= 12 && !compactionSeen; i += 1) {
    const prompt =
      i === 1
        ? "Start a story. The hero's secret name is ZEPHYR-NINE. Write ~120 words."
        : `Continue the story with ~120 more words (part ${i}). Keep going.`;
    const turn = await runTurn(prompt, {
      ...(sessionId ? { resume: sessionId } : {}),
      sessionStore: store,
      settings,
    });
    sessionId = turn.sessionId || sessionId;
    if (i === 1) {
      firstFact = turn.reply.slice(0, 60);
    }
    const hadBoundary = turn.compactions.length > 0;
    console.log(
      `turn ${i}: input=${turn.inputTokens}tok stream=[${turn.streamTypes.join(",")}]${hadBoundary ? "  ← COMPACT_BOUNDARY" : ""}`,
    );
    if (hadBoundary) {
      compactionSeen = true;
      console.log(`  compact_metadata: ${short(turn.compactions[0], 400)}`);
    }
  }

  console.log(`\nstore now has ${store.frames.length} frames:`);
  console.log(`  [${frameSummary(store.frames)}]`);
  const boundaryIdx = store.frames.findIndex((f) => f.type === "compact_boundary");
  console.log(`compact_boundary frame in store at index: ${boundaryIdx}`);
  if (boundaryIdx >= 0) {
    console.log(`  boundary frame: ${short(store.frames[boundaryIdx], 500)}`);
    console.log(`  frames BEFORE boundary retained: ${boundaryIdx} (pre-compaction frames kept?)`);
  }

  if (!compactionSeen) {
    console.log("\n⚠ no compaction fired — try a smaller WINDOW or more turns.");
    return;
  }

  // What actually got PERSISTED, and IS there a real summary or just a marker?
  const sysIdx = store.frames.findIndex(
    (f) => f.type === "system" && f["subtype"] === "compact_boundary",
  );
  if (sysIdx >= 0) {
    console.log(`\nboundary frame (index ${sysIdx}):`);
    console.log(`  ${short(store.frames[sysIdx], 1400)}`);
    console.log(`\nframe AFTER the boundary (index ${sysIdx + 1}) — does it carry the summary?`);
    console.log(`  ${short(store.frames[sysIdx + 1], 1400)}`);
  }

  console.log("\n── resume AFTER compaction (×2): recall + does EVERY resume re-compact? ──");
  for (let r = 1; r <= 2; r += 1) {
    const after = await runTurn("What is the hero's secret name? Reply with only it.", {
      resume: sessionId,
      sessionStore: store,
      settings,
    });
    sessionId = after.sessionId || sessionId;
    console.log(
      `  resume ${r}: input=${after.inputTokens}tok recalled=${after.reply.includes("ZEPHYR-NINE") ? "YES" : "NO"} reCompacted=${after.compactions.length > 0 ? "YES" : "no"} reply=${JSON.stringify(after.reply.slice(0, 40))}`,
    );
  }
  console.log(`  (early turn-1 opening was: ${JSON.stringify(firstFact)})`);
}

async function phaseD(): Promise<void> {
  console.log("\n══ PHASE D — can we STEER the compaction prompt via manual /compact? ══");
  const store = new RecordingStore();
  let sessionId = "";
  // Build a few turns with a specific detail to test whether a custom prompt preserves it.
  for (let i = 1; i <= 4; i += 1) {
    const prompt =
      i === 1
        ? "Begin a noir story. The detective's badge number is 4471-DELTA. ~80 words."
        : `Continue ~80 words (part ${i}).`;
    const turn = await runTurn(prompt, {
      ...(sessionId ? { resume: sessionId } : {}),
      sessionStore: store,
    });
    sessionId = turn.sessionId || sessionId;
  }

  const before = store.frames.length;
  // Manual compaction WITH an RP-tuned instruction — the thing auto-compaction can't do.
  const rpPrompt =
    "/compact Summarize for roleplay continuity: preserve character names, the detective's exact badge number, relationships, and emotional beats verbatim. Write a self-contained summary. Do NOT reference any external transcript file.";
  const c = await runTurn(rpPrompt, { resume: sessionId, sessionStore: store });
  sessionId = c.sessionId || sessionId;
  console.log(`/compact turn stream: [${c.streamTypes.join(", ")}]`);
  console.log(`compaction fired: ${c.compactions.length > 0 ? "YES" : "NO"}`);
  if (c.compactions.length > 0) {
    console.log(`  compact_metadata: ${short(c.compactions[0], 300)}`);
  }
  console.log(`frames ${before} → ${store.frames.length}`);

  // Dump the persisted summary (the user frame after the boundary) to see if it FOLLOWED
  // our instructions + dropped the /tmp crutch.
  const sysIdx = store.frames.findIndex(
    (f) => f.type === "system" && f["subtype"] === "compact_boundary",
  );
  if (sysIdx >= 0) {
    const summaryFrame = store.frames[sysIdx + 1];
    const summaryJson = JSON.stringify(summaryFrame);
    console.log(`\nsummary frame (after boundary at ${sysIdx}), ${summaryJson.length} chars:`);
    console.log(`  ${short(summaryFrame, 2600)}`);
    console.log("\n── did our instructions land? ──");
    console.log(
      `  badge 4471-DELTA in summary: ${summaryJson.includes("4471-DELTA") ? "YES ✓" : "NO ✗"}`,
    );
    console.log(
      `  /tmp transcript crutch present: ${/tmp\/claude-resume|read the full transcript/i.test(summaryJson) ? "YES ✗" : "NO ✓ (dropped)"}`,
    );

    const recall = await runTurn("What is the detective's badge number? Reply with only it.", {
      resume: sessionId,
      sessionStore: store,
    });
    console.log(
      `  resume recall: ${JSON.stringify(recall.reply.slice(0, 40))} → ${recall.reply.includes("4471-DELTA") ? "RECALLED ✓" : "LOST ✗"}`,
    );
  } else {
    console.log("\n(no compact_boundary frame found — /compact may not have compacted)");
  }
}

async function main(): Promise<void> {
  console.log(`Compaction/seeding probe — model=${MODEL}`);
  if (process.env["COMPACTPROMPT"] === "1") {
    await phaseD();
    return;
  }
  const captured = await phaseA();
  await phaseB(captured);
  if (process.env["COMPACT"] === "1") {
    await phaseC();
  } else {
    console.log("\n(skip PHASE C — set COMPACT=1 to force a real compaction)");
  }
}

await main().catch((error: unknown) => {
  console.error("probe failed:", error);
  process.exitCode = 1;
});
