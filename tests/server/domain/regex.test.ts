import { describe, expect, it } from "vitest";
import { createRegexService } from "../../../src/server/domain/regex/service";
import { SimpleMacroRegistry } from "../../../src/shared/macro/registry";
import type { MacroContext } from "../../../src/shared/macro/types";
import type { RegexScript } from "../../../src/shared/regex";

describe("Regex Domain Service", () => {
  const service = createRegexService();

  const mockCtx: MacroContext = {
    char: "Seraphina",
    user: "Inktomi",
    persona: "",
    scenario: "",
    env: {},
    evaluateAST: () => "",
    evaluateString: () => "",
  };

  const registry = new SimpleMacroRegistry();
  registry.register("char", () => "Seraphina");
  registry.register("user", () => "Inktomi");

  it("replaces a simple string without capture groups", () => {
    const scripts = [
      {
        id: "1",
        name: "Test",
        findRegex: "hello",
        replaceString: "hi",
        placement: ["AI_OUTPUT"],
        enabled: true,
      } as unknown as RegexScript,
    ];

    const result = service.executeScripts(
      "hello world, hello there",
      scripts,
      "AI_OUTPUT",
      mockCtx,
    );
    // Since flags default to 'gm', all instances of 'hello' should be replaced
    expect(result).toBe("hi world, hi there");
  });

  it("respects placement and enabled status", () => {
    const scripts = [
      {
        id: "1",
        name: "Disabled",
        findRegex: "hello",
        replaceString: "hi",
        placement: ["AI_OUTPUT"],
        enabled: false,
      } as unknown as RegexScript,
      {
        id: "2",
        name: "Wrong Placement",
        findRegex: "world",
        replaceString: "earth",
        placement: ["USER_INPUT"],
        enabled: true,
      } as unknown as RegexScript,
    ];

    const result = service.executeScripts("hello world", scripts, "AI_OUTPUT", mockCtx);
    expect(result).toBe("hello world"); // No replacements should occur
  });

  it("handles numbered capture groups", () => {
    const scripts = [
      {
        id: "1",
        name: "Asterisks",
        findRegex: "/\\*(.*?)\\*/g", // Explicit flags
        replaceString: "[$1]",
        placement: ["AI_OUTPUT"],
        enabled: true,
      } as unknown as RegexScript,
    ];

    const result = service.executeScripts("She *smiled* gently.", scripts, "AI_OUTPUT", mockCtx);
    expect(result).toBe("She [smiled] gently.");
  });

  it("handles $0 and {{match}} as full match", () => {
    const scripts = [
      {
        id: "1",
        name: "Full Match",
        findRegex: "test",
        replaceString: "[$0|{{match}}]",
        placement: ["AI_OUTPUT"],
        enabled: true,
      } as unknown as RegexScript,
    ];

    const result = service.executeScripts("this is a test.", scripts, "AI_OUTPUT", mockCtx);
    expect(result).toBe("this is a [test|test].");
  });

  it("evaluates macros AFTER capture groups", () => {
    // We must pass a real evaluateString that resolves macros via our engine,
    // but the regex service relies on `processMacros` which takes `ctx`.
    // Wait, processMacros needs the registry if we want it to work.
    // The service currently uses `processMacros(replacement, ctx)`.

    // We need to inject the mock evaluateString and evaluateAST to processMacros,
    // actually processMacros uses `globalMacroRegistry` by default if not passed.
    // Let's rely on the real `processMacros` behavior.

    const scripts = [
      {
        id: "1",
        name: "Macro Injection",
        findRegex: "I am (.*)",
        replaceString: "You are $1, and I am {{char}}",
        placement: ["AI_OUTPUT"],
        enabled: true,
      } as unknown as RegexScript,
    ];

    const result = service.executeScripts("I am Inktomi", scripts, "AI_OUTPUT", mockCtx);
    // processMacros will use the `ctx` we pass in. `ctx.char` is "Seraphina".
    // Wait, the global registry defaults for `char` look at `ctx.char`.
    expect(result).toBe("You are Inktomi, and I am Seraphina");
  });
});
