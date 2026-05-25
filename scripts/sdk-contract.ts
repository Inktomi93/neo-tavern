import process from "node:process";
import {
  getSessionMessages,
  InMemorySessionStore,
  type Options,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeSdkEnv } from "../src/server/env";

/**
 * Conversational contract probe — does the Agent SDK behave the way neo-tavern's
 * design ASSUMES? These are LIVE behavioral checks (each turn costs a sub query),
 * so this is NOT part of `pnpm check`; run on demand: `pnpm sdk:contract`.
 *
 * Re-run after an SDK upgrade — if an assumption our design hinges on breaks, a
 * check goes red here instead of silently in production.
 */

function baseOptions(): Options {
  return {
    model: "claude-haiku-4-5-20251001",
    maxTurns: 1,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    env: buildClaudeSdkEnv(),
  };
}

async function run(
  prompt: string,
  extra: Partial<Options> = {},
): Promise<{ text: string; sessionId: string }> {
  let text = "";
  let sessionId = "";
  for await (const message of query({ prompt, options: { ...baseOptions(), ...extra } })) {
    if ("session_id" in message && typeof message.session_id === "string") {
      sessionId = message.session_id;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          text += block.text;
        }
      }
    }
  }
  return { text: text.trim(), sessionId };
}

let failures = 0;
function check(name: string, pass: boolean, detail: string): void {
  if (!pass) {
    failures += 1;
  }
  console.log(`${pass ? "✅" : "❌"} ${name}\n     ${detail}`);
}

async function main(): Promise<void> {
  console.log("Conversational contract — the assumptions neo-tavern's design hinges on\n");

  // 1. The character card (systemPrompt) actually drives the persona.
  const persona = await run("Who are you? One short sentence.", {
    systemPrompt: "You are Lyra, a terse fire-mage. Always answer in character and reference fire.",
  });
  check(
    "systemPrompt drives the character (card → persona)",
    /lyra|fire|flame|mage|ember/i.test(persona.text),
    JSON.stringify(persona.text),
  );

  // 2 + 3 + 4 in ONE 5-turn conversation, backed by a custom store:
  //   - establish four facts across four turns,
  //   - then at turn 5 recall the EARLIEST facts (the real test — short resume
  //     "works" while long conversations silently drop early context).
  const store = new InMemorySessionStore();
  const facts = [
    "My name is Vex. Reply only 'noted'.",
    "I carry an obsidian dagger named Whisper. Reply only 'noted'.",
    "We are in the rain-soaked city of Ravenhold. Reply only 'noted'.",
    "My companion is a raven named Mott. Reply only 'noted'.",
  ];
  let sessionId = "";
  for (const fact of facts) {
    const turn = await run(
      fact,
      sessionId ? { resume: sessionId, sessionStore: store } : { sessionStore: store },
    );
    sessionId = turn.sessionId;
  }
  const recall = await run(
    "Without preamble, state: my name, my dagger's name, the city we're in, and my companion's name.",
    { resume: sessionId, sessionStore: store },
  );
  const text = recall.text.toLowerCase();
  const remembered = {
    name: text.includes("vex"),
    dagger: text.includes("whisper") || text.includes("obsidian"),
    city: text.includes("ravenhold"),
    companion: text.includes("mott"),
  };
  const kept = Object.values(remembered).filter(Boolean).length;
  check(
    `context tracks across a 5-turn conversation (recalled ${kept}/4 facts, incl. the earliest)`,
    kept === 4,
    `turn5=${JSON.stringify(recall.text)}`,
  );

  // The session transcript (from our custom store) is a user/assistant/system
  // record — so the character greeting + imported chats get SEEDED here (assistant
  // turns can't come through the prompt, which is type-locked to user messages).
  const transcript = await getSessionMessages(sessionId, { sessionStore: store });
  const roles = transcript.map((entry) => entry.type);
  check(
    "session transcript holds assistant turns across the whole conversation (greeting/import seed target)",
    roles.includes("assistant") && roles.filter((r) => r === "assistant").length >= 4,
    `${roles.length} entries, roles=[${[...new Set(roles)].join(", ")}]`,
  );

  console.log(`\n${3 - failures}/3 contracts hold.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  console.error("contract probe failed:", error);
  process.exitCode = 1;
});
