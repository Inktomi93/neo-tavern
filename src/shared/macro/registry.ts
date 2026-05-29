import { DateTime } from "luxon";
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

  // Formatting
  registry.register("newline", () => "\n");
  // {{#trim}}…{{/trim}} — evaluate the block body, then strip leading/trailing whitespace.
  registry.register("trim", (_args, ctx, children) =>
    children ? ctx.evaluateAST(children).trim() : "",
  );

  // Clock — locale-independent formats (testable; server-local ≈ user-local on the homelab box).
  registry.register("time", () => DateTime.now().toFormat("HH:mm:ss"));
  registry.register("date", () => DateTime.now().toFormat("yyyy-MM-dd"));

  // Dice: {{roll::NdM}} (sum of N M-sided dice) or {{roll::N}} (1..N). Empty/invalid → "".
  registry.register("roll", (args) => {
    const spec = args[0]?.trim().toLowerCase();
    if (!spec) return "";
    const dice = spec.match(/^(\d*)d(\d+)$/);
    if (dice) {
      const count = dice[1] ? parseInt(dice[1], 10) : 1;
      const sides = parseInt(dice[2] ?? "", 10);
      if (count < 1 || sides < 1) return "";
      let total = 0;
      for (let i = 0; i < count; i++) total += Math.floor(Math.random() * sides) + 1;
      return String(total);
    }
    if (/^\d+$/.test(spec)) {
      const n = parseInt(spec, 10);
      return n < 1 ? "" : String(Math.floor(Math.random() * n) + 1);
    }
    return "";
  });

  // Conversation context (set by the chat send/assembly path; "" elsewhere).
  registry.register("input", (_args, ctx) => ctx.input ?? "");
  registry.register("lastMessage", (_args, ctx) => ctx.lastMessage ?? "");
  registry.register("lastUserMessage", (_args, ctx) => ctx.lastUserMessage ?? "");
  registry.register("lastCharMessage", (_args, ctx) => ctx.lastCharMessage ?? "");

  return registry;
}
