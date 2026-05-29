import { z } from "zod";
import { authedProcedure, t } from "../trpc";

// Per-user OpenRouter key management (docs/auth-and-credentials-plan.md §7). authedProcedure (a user
// manages their OWN key — not admin). The key is write-only over the wire: stored encrypted, never
// returned; only a boolean presence check is readable.
export const credentialsRouter = t.router({
  hasMyOpenRouterKey: authedProcedure.query(({ ctx }) =>
    ctx.services.credentials.hasMyOpenRouterKey({ username: ctx.username }),
  ),

  setMyOpenRouterKey: authedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.credentials.setMyOpenRouterKey({ username: ctx.username, ...input }),
    ),

  clearMyOpenRouterKey: authedProcedure.mutation(({ ctx }) =>
    ctx.services.credentials.clearMyOpenRouterKey({ username: ctx.username }),
  ),
});
