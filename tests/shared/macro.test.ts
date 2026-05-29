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
