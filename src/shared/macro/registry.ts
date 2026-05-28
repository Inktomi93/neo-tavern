import type { MacroHandler, MacroRegistry } from "./types";

export class SimpleMacroRegistry implements MacroRegistry {
  private handlers = new Map<string, MacroHandler>();

  register(name: string, handler: MacroHandler): void {
    this.handlers.set(name.toLowerCase(), handler);
  }

  get(name: string): MacroHandler | undefined {
    return this.handlers.get(name.toLowerCase());
  }
}

export function createDefaultRegistry(): MacroRegistry {
  const registry = new SimpleMacroRegistry();

  // Basic RP Context
  registry.register("char", (_args, ctx) => ctx.char);
  registry.register("user", (_args, ctx) => ctx.user);
  registry.register("persona", (_args, ctx) => ctx.persona);
  registry.register("scenario", (_args, ctx) => ctx.scenario);

  // Variables/Env (Foundation for regex extension & advanced macros)
  registry.register("get", (args, ctx) => {
    const key = args[0]?.trim();
    if (!key) return "";
    return String(ctx.env[key] ?? "");
  });

  // Utilities
  registry.register("random", (args) => {
    if (args.length < 2) return "";
    const min = parseInt(args[0] ?? "", 10);
    const max = parseInt(args[1] ?? "", 10);
    if (Number.isNaN(min) || Number.isNaN(max)) return "";
    return String(Math.floor(Math.random() * (max - min + 1)) + min);
  });

  registry.register("pick", (args) => {
    if (args.length === 0) return "";
    const index = Math.floor(Math.random() * args.length);
    return args[index] ?? "";
  });

  // Blocks
  registry.register("if", (args, ctx, children) => {
    const key = args[0]?.trim();
    if (!key) return "";

    let val: unknown = ctx.env[key];
    if (key === "char") val = ctx.char;
    if (key === "user") val = ctx.user;
    if (key === "persona") val = ctx.persona;
    if (key === "scenario") val = ctx.scenario;

    if (val && String(val).trim() !== "") {
      return children ? ctx.evaluateAST(children) : "";
    }
    return "";
  });

  return registry;
}
