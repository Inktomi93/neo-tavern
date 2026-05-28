import { describe, expect, it } from "vitest";
import type { ProcessMacroOptions } from "../../src/shared/macro/index";
import { processMacros } from "../../src/shared/macro/index";

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
