import { z } from "zod";
import { adminProcedure, t } from "../trpc";

// User administration (docs/auth-and-credentials-plan.md §6) — every procedure adminProcedure-gated.
// No UI.
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

  // Server-side sessions: list a user's devices, kick one, or kick all (immediate, not at expiry).
  listSessions: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      ctx.services.admin.listSessions({ username: ctx.username, ...input }),
    ),

  revokeSession: adminProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.revokeSession({ username: ctx.username, ...input }),
    ),

  revokeUserSessions: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.revokeUserSessions({ username: ctx.username, ...input }),
    ),
});
