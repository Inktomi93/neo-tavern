import { initTRPC } from "@trpc/server";
import type { Context } from "./context";

// The tRPC init lives here (not in router.ts) so sub-routers can import `t` without
// a cycle through the root router.
export const t = initTRPC.context<Context>().create();

export const publicProcedure = t.procedure;
