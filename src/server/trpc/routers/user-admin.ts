import { z } from "zod";
import { adminProcedure, t } from "../trpc";

// User administration (docs/auth-and-credentials-plan.md §6) — every procedure adminProcedure-gated.
// Session listing/revocation joins this router in commit 4 (it needs the sessions service). No UI.
export const userAdminRouter = t.router({
  listUsers: adminProcedure.query(({ ctx }) =>
    ctx.services.admin.listUsers({ username: ctx.username }),
  ),

  setRole: adminProcedure
    .input(z.object({ userId: z.string().min(1), role: z.enum(["admin", "user"]) }))
    .mutation(({ ctx, input }) => ctx.services.admin.setRole({ username: ctx.username, ...input })),

  setEnabled: adminProcedure
    .input(z.object({ userId: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.setEnabled({ username: ctx.username, ...input }),
    ),
});
