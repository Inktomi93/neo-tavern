import { expect, test } from "vitest";
import { type AssembleContext, assemblePrompt } from "../../src/shared/prompt-assemble";
import { DEFAULT_PROMPT_CONFIG, parsePromptConfig } from "../../src/shared/prompt-config";

function ctx(overrides: Partial<AssembleContext> = {}): AssembleContext {
  return {
    character: {
      name: "Aria",
      description: "A {{char}} who guards the obsidian gate.",
      personality: "stern but fair",
      scenario: "dusk at the gate",
      exampleMessages: "Aria: Halt. State your business.",
      postHistoryInstructions: "Keep replies terse and in-character.",
    },
    pinnedPersona: { name: "Kael", description: "a wandering scholar" },
    activePersona: { name: "Kael", description: "a wandering scholar" },
    worldEntries: [
      {
        content: "The gate is forged from obsidian.",
        scope: "always",
        keys: [],
        priority: 0,
        enabled: true,
        source: "character",
      },
      {
        content: "Dragons are said to fear the gate.",
        scope: "keyword",
        keys: ["dragon"],
        priority: 0,
        enabled: true,
        source: "character",
      },
    ],
    recentMessages: ["Tell me about the gate."],
    ...overrides,
  };
}

test("static half carries character + persona + always-WI, with macros rendered", () => {
  const { static: staticPrompt, dynamic } = assemblePrompt(DEFAULT_PROMPT_CONFIG, ctx());

  // {{char}} / {{user}} resolved (main literal + the description's inline macro)
  expect(staticPrompt).toContain("You are Aria");
  expect(staticPrompt).toContain("with Kael"); // {{user}} → persona name
  expect(staticPrompt).toContain("A Aria who guards the obsidian gate"); // macro inside the card field
  expect(staticPrompt).toContain("stern but fair"); // personality
  expect(staticPrompt).toContain("dusk at the gate"); // scenario
  expect(staticPrompt).toContain("a wandering scholar"); // persona
  expect(staticPrompt).toContain("forged from obsidian"); // always-WI lives in the static half

  // keyword-WI must NOT be in the static half (it's after the boundary)
  expect(staticPrompt).not.toContain("Dragons");
  // and not active anyway — no "dragon" in recent messages
  expect(dynamic).not.toContain("Dragons");
});

test("keyword-WI activates in the DYNAMIC half only when a key matches recent messages", () => {
  const hit = assemblePrompt(
    DEFAULT_PROMPT_CONFIG,
    ctx({ recentMessages: ["Have you seen the dragon near the gate?"] }),
  );
  expect(hit.dynamic).toContain("Dragons are said to fear");
  expect(hit.static).not.toContain("Dragons"); // never leaks into the cached half

  const miss = assemblePrompt(DEFAULT_PROMPT_CONFIG, ctx({ recentMessages: ["Nice weather."] }));
  expect(miss.dynamic).not.toContain("Dragons");
});

test("keyword match is whole-word (no substring false positives)", () => {
  // "dragonfly" must NOT trigger the "dragon" key
  const result = assemblePrompt(
    DEFAULT_PROMPT_CONFIG,
    ctx({ recentMessages: ["A dragonfly landed on the sill."] }),
  );
  expect(result.dynamic).not.toContain("Dragons are said to fear");
});

test("char_system + post_history are OFF by default — not sent even when the card has them", () => {
  const { static: staticPrompt, dynamic } = assemblePrompt(
    DEFAULT_PROMPT_CONFIG,
    ctx({
      character: {
        name: "Aria",
        description: "guard",
        systemPrompt: "CARD-SYSTEM-OVERRIDE",
        postHistoryInstructions: "JAILBREAK-TEXT",
      },
    }),
  );
  const all = `${staticPrompt}\n${dynamic}`;
  expect(all).not.toContain("CARD-SYSTEM-OVERRIDE"); // char_system marker is enabled:false
  expect(all).not.toContain("JAILBREAK-TEXT"); // post_history marker is enabled:false
});

test("a section's enabled toggle controls whether it is sent", () => {
  const on = parsePromptConfig({
    sections: [
      { type: "marker", id: "d", name: "Description", marker: "char_description", enabled: true },
    ],
  });
  const off = parsePromptConfig({
    sections: [
      { type: "marker", id: "d", name: "Description", marker: "char_description", enabled: false },
    ],
  });
  expect(assemblePrompt(on, ctx()).static).toContain("description");
  expect(assemblePrompt(off, ctx()).static).toBe(""); // toggled off → omitted entirely
});

test("empty / missing character fields are skipped, not rendered blank", () => {
  const { static: staticPrompt } = assemblePrompt(
    DEFAULT_PROMPT_CONFIG,
    ctx({
      character: { name: "Bare", description: "Just a description." },
      pinnedPersona: null,
      activePersona: null,
    }),
  );
  expect(staticPrompt).toContain("Just a description.");
  expect(staticPrompt).not.toContain("personality:"); // no personality field → no label
  expect(staticPrompt).not.toContain("Scenario:");
});

test("the default config round-trips through parsePromptConfig (the stored-blob path)", () => {
  const parsed = parsePromptConfig(DEFAULT_PROMPT_CONFIG);
  expect(parsed.sections.filter((s) => s.type === "boundary")).toHaveLength(1);
  // re-assembling from the parsed config matches the direct config
  const a = assemblePrompt(parsed, ctx());
  const b = assemblePrompt(DEFAULT_PROMPT_CONFIG, ctx());
  expect(a).toEqual(b);
});

test("persona pin: card-field {{user}} stays PINNED while user-field {{user}} follows ACTIVE", () => {
  // The user opened the chat as "John" (pinned) but switched their active persona to "Sarah".
  const split = assemblePrompt(
    DEFAULT_PROMPT_CONFIG,
    ctx({
      character: {
        name: "Aria",
        description: "{{user}} is my brother.", // a CARD field referencing {{user}}
      },
      pinnedPersona: { name: "John", description: "the older brother" },
      activePersona: { name: "Sarah", description: "a newcomer" },
    }),
  );
  const all = `${split.static}\n${split.dynamic}`;
  // card field keeps the ORIGINAL identity — no retroactive rewrite
  expect(all).toContain("John is my brother.");
  expect(all).not.toContain("Sarah is my brother.");
  // the user-authored main literal ("...roleplay with {{user}}") follows the ACTIVE persona
  expect(split.static).toContain("with Sarah");
});

test("a character-lorebook entry's {{user}} is pinned; a chat-attached entry's is active", () => {
  const split = assemblePrompt(DEFAULT_PROMPT_CONFIG, {
    character: { name: "Aria", description: "guard" },
    pinnedPersona: { name: "John", description: "x" },
    activePersona: { name: "Sarah", description: "y" },
    recentMessages: [],
    worldEntries: [
      {
        content: "{{user}} owns the gate.",
        scope: "always",
        keys: [],
        priority: 0,
        enabled: true,
        source: "character",
      },
      {
        content: "{{user}} is new in town.",
        scope: "always",
        keys: [],
        priority: 0,
        enabled: true,
        source: "chat",
      },
    ],
  });
  expect(split.static).toContain("John owns the gate."); // character-source → pinned
  expect(split.static).toContain("Sarah is new in town."); // chat-source → active
});

test("rejects a config with more than one boundary", () => {
  expect(() =>
    parsePromptConfig({
      schemaVersion: 1,
      sections: [
        { type: "boundary", id: "b1" },
        { type: "boundary", id: "b2" },
      ],
      params: {},
    }),
  ).toThrow();
});
