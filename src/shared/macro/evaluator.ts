import type { MacroAST, MacroContext, MacroRegistry } from "./types";

export function evaluateMacros(ast: MacroAST, registry: MacroRegistry, ctx: MacroContext): string {
  let result = "";

  for (const node of ast) {
    if (node.type === "text") {
      result += node.value;
    } else if (node.type === "macro") {
      const handler = registry.get(node.name);
      if (handler) {
        // Resolve nested macros inside arguments
        const resolvedArgs = node.args.map((arg) => {
          if (arg.includes("{{")) {
            return ctx.evaluateString(arg);
          }
          return arg;
        });

        try {
          const val = handler(resolvedArgs, ctx);
          result += ctx.postProcess ? ctx.postProcess(val) : val;
        } catch (err) {
          ctx.onWarn?.(`[Macro Engine] Error evaluating macro ${node.name}`, err);
          result += `{{${node.name}}}`;
        }
      } else {
        // Unrecognized macro, leave it as is
        const argSuffix = node.args.length > 0 ? `::${node.args.join("::")}` : "";
        result += `{{${node.name}${argSuffix}}}`;
      }
    } else if (node.type === "block") {
      const handler = registry.get(node.name);
      if (handler) {
        const resolvedArgs = node.args.map((arg) => {
          if (arg.includes("{{")) {
            return ctx.evaluateString(arg);
          }
          return arg;
        });

        try {
          const val = handler(resolvedArgs, ctx, node.children);
          result += ctx.postProcess ? ctx.postProcess(val) : val;
        } catch (err) {
          ctx.onWarn?.(`[Macro Engine] Error evaluating block ${node.name}`, err);
          result += `{{#${node.name}}}`;
        }
      } else {
        // Unrecognized block
        const argSuffix = node.args.length > 0 ? `::${node.args.join("::")}` : "";
        result += `{{#${node.name}${argSuffix}}}`;
        result += evaluateMacros(node.children, registry, ctx);
        result += `{{/${node.name}}}`;
      }
    }
  }

  return result;
}
