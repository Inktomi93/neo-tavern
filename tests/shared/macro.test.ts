import { describe, expect, it } from "vitest";
import type { ProcessMacroOptions } from "../../src/shared/macro/index";
import { processMacros } from "../../src/shared/macro/index";
import { SimpleMacroRegistry } from "../../src/shared/macro/registry";

describe("Macro Engine", () => {
  const ctx: ProcessMacroOptions = {
    char: "Alice",
    user: "Bob",
    persona: "A friendly guy",
    scenario: "At a cafe",
    env: {
      myVar: "hello world",
      isTrue: true,
      isFalse: false,
    },
  };

  it("evaluates basic variables", () => {
    const result = processMacros("Hello {{user}}, I am {{char}}.", ctx);
    expect(result).toBe("Hello Bob, I am Alice.");
  });

  it("leaves unrecognized macros alone", () => {
    const result = processMacros("Here is an {{unknown}} macro.", ctx);
    expect(result).toBe("Here is an {{unknown}} macro.");
  });

  it("handles basic utilities like get", () => {
    const result = processMacros("Var is {{get::myVar}}.", ctx);
    expect(result).toBe("Var is hello world.");
  });

  it("handles missing variables gracefully", () => {
    const result = processMacros("Var is {{get::missing}}.", ctx);
    expect(result).toBe("Var is .");
  });

  it("evaluates blocks when truthy", () => {
    const result = processMacros("{{#if isTrue}}Inside the block!{{/if}}", ctx);
    expect(result).toBe("Inside the block!");
  });

  it("ignores blocks when falsy", () => {
    const result = processMacros("{{#if isFalse}}Inside the block!{{/if}}", ctx);
    expect(result).toBe("");
  });

  it("handles standard ST string checks in if block", () => {
    const result = processMacros("{{#if char}}Character is here{{/if}}", ctx);
    expect(result).toBe("Character is here");
  });

  it("parses single colon arguments correctly", () => {
    const result = processMacros("Var is {{get:myVar}}.", ctx);
    expect(result).toBe("Var is hello world.");
  });

  it("supports random utility with colons", () => {
    // We mock random for this test, but just checking format parsing
    const result = processMacros("{{random:1, 1}}", ctx);
    expect(result).toBe("1");
  });

  it("evaluates nested macros inside arguments", () => {
    const result = processMacros("Var is {{get::{{pick::myVar}}}}.", ctx);
    // pick of myVar should yield myVar, then get myVar yields hello world
    expect(result).toBe("Var is hello world.");
  });

  it("preserves unclosed macros as text", () => {
    const result = processMacros("This is {{unclosed", ctx);
    expect(result).toBe("This is {{unclosed");
  });

  it("preserves unbalanced block closes as text", () => {
    const result = processMacros("This is {{/unmatched}}", ctx);
    expect(result).toBe("This is {{/unmatched}}");
  });

  it("correctly identifies multiple sequential macros", () => {
    const result = processMacros("{{char}}{{user}}", ctx);
    expect(result).toBe("AliceBob");
  });
});

// Edge & error branches of the AST parser/evaluator — the paths most likely to hide a parser bug.
describe("Macro Engine — edge & error branches", () => {
  const ctx: ProcessMacroOptions = {
    char: "Alice",
    user: "Bob",
    persona: "",
    scenario: "",
    env: { myVar: "hello world" },
  };

  it("treats an invalid identifier ({{123}}) as literal text", () => {
    expect(processMacros("a {{123}} b", ctx)).toBe("a {{123}} b");
  });

  it("nests blocks: inner block evaluates inside the outer (both same name)", () => {
    expect(processMacros("{{#if char}}A{{#if user}}B{{/if}}C{{/if}}", ctx)).toBe("ABC");
  });

  it("nests blocks: a falsy inner block drops only its own body", () => {
    expect(processMacros("{{#if char}}A{{#if missing}}B{{/if}}C{{/if}}", ctx)).toBe("AC");
  });

  it("a mismatched close pops the stack to the match (graceful, no crash)", () => {
    // {{/a}} closes down to the open `a`, auto-synthesizing the inner b's close. Unknown blocks
    // round-trip as literal text with their children evaluated.
    expect(processMacros("{{#a}}{{#b}}{{/a}}", ctx)).toBe("{{#a}}{{#b}}{{/b}}{{/a}}");
  });

  it("an unknown block round-trips as text but still evaluates its children", () => {
    expect(processMacros("{{#box}}Hi {{char}}{{/box}}", ctx)).toBe("{{#box}}Hi Alice{{/box}}");
  });

  it("a throwing macro handler is caught: onWarn fires and the macro is left literal", () => {
    const registry = new SimpleMacroRegistry();
    registry.register("boom", () => {
      throw new Error("kaboom");
    });
    let warned = false;
    const result = processMacros(
      "x {{boom}} y",
      {
        ...ctx,
        onWarn: () => {
          warned = true;
        },
      },
      registry,
    );
    expect(result).toBe("x {{boom}} y");
    expect(warned).toBe(true);
  });

  it("splits multiple :: arguments", () => {
    const registry = new SimpleMacroRegistry();
    registry.register("join", (args) => args.join("|"));
    expect(processMacros("{{join::a::b::c}}", ctx, registry)).toBe("a|b|c");
  });

  it("does NOT split on a :: that lives inside a nested macro's args", () => {
    const registry = new SimpleMacroRegistry();
    registry.register("join", (args) => args.join("|"));
    registry.register("echo", (args) => args.join(""));
    // The inner echo's `::` must not split the outer join → outer args stay ["{{echo::1::2}}", "b"].
    expect(processMacros("{{join::{{echo::1::2}}::b}}", ctx, registry)).toBe("12|b");
  });
});

// The vocabulary added in the "completeness" batch: formatting, dice, clock, comments, and the
// conversation-context macros ({{input}}/{{lastMessage}}/…).
describe("Macro Engine — new vocabulary", () => {
  const base: ProcessMacroOptions = {
    char: "Alice",
    user: "Bob",
    persona: "",
    scenario: "",
    env: {},
  };

  it("{{newline}} → a literal newline", () => {
    expect(processMacros("a{{newline}}b", base)).toBe("a\nb");
  });

  it("{{#trim}} strips surrounding whitespace from the evaluated body", () => {
    expect(processMacros("[{{#trim}}  {{char}}  {{/trim}}]", base)).toBe("[Alice]");
  });

  it("{{roll::NdM}} sums dice (deterministic for d1) and stays in range", () => {
    expect(processMacros("{{roll::3d1}}", base)).toBe("3"); // 3 × d1 = 3
    expect(processMacros("{{roll::1d1}}", base)).toBe("1");
    const n = Number(processMacros("{{roll::2d6}}", base));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(12);
    const m = Number(processMacros("{{roll::6}}", base));
    expect(m).toBeGreaterThanOrEqual(1);
    expect(m).toBeLessThanOrEqual(6);
    expect(processMacros("{{roll::nonsense}}", base)).toBe(""); // invalid → empty
  });

  it("{{time}} and {{date}} render locale-independent formats", () => {
    expect(processMacros("{{time}}", base)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(processMacros("{{date}}", base)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("{{// comment}} is stripped (and survives a nested {{macro}} inside it)", () => {
    expect(processMacros("x {{// a note}} y", base)).toBe("x  y");
    expect(processMacros("x {{// has {{char}} inside}} y", base)).toBe("x  y");
  });

  it("an unclosed {{// comment is preserved as literal text", () => {
    expect(processMacros("a {{// unclosed", base)).toBe("a {{// unclosed");
  });

  it("{{input}}/{{lastMessage}}/{{lastUserMessage}}/{{lastCharMessage}} resolve from context", () => {
    const ctx: ProcessMacroOptions = {
      ...base,
      input: "what about the key",
      lastMessage: "the pass, always",
      lastUserMessage: "what do you guard",
      lastCharMessage: "the pass, always",
    };
    expect(processMacros("{{input}}", ctx)).toBe("what about the key");
    expect(processMacros("{{lastUserMessage}}", ctx)).toBe("what do you guard");
    expect(processMacros("{{lastMessage}}|{{lastCharMessage}}", ctx)).toBe(
      "the pass, always|the pass, always",
    );
  });

  it("conversation macros resolve to empty when the context lacks them", () => {
    expect(processMacros("[{{input}}][{{lastMessage}}]", base)).toBe("[][]");
  });
});
