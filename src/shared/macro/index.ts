import { evaluateMacros } from "./evaluator";
import { parseMacros } from "./parser";
import { createDefaultRegistry } from "./registry";
import type { MacroAST, MacroContext, MacroRegistry } from "./types";

// A singleton registry for the application, so extensions can register new macros globally
export const globalMacroRegistry = createDefaultRegistry();

export type ProcessMacroOptions = Omit<MacroContext, "evaluateString" | "evaluateAST">;

/**
 * Process macros in a string, replacing them with their evaluated values.
 * This combines Lexing, Parsing, and Evaluating into a single call.
 *
 * @param text The text containing macros (e.g. `Hello {{user}}`)
 * @param options Context variables needed for macro evaluation (e.g. char, user, env)
 * @param registry Optional custom macro registry (defaults to the global registry)
 */
export function processMacros(
  text: string,
  options: ProcessMacroOptions,
  registry: MacroRegistry = globalMacroRegistry,
): string {
  const evalAST = (astNode: MacroAST) => evaluateMacros(astNode, registry, ctx);
  const evalString = (str: string) => evalAST(parseMacros(str));

  const ctx: MacroContext = {
    ...options,
    evaluateString: evalString,
    evaluateAST: evalAST,
  };

  const ast = parseMacros(text);
  return evalAST(ast);
}
