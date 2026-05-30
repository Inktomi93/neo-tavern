import { z } from "zod";
import { brandedId, type SessionId, type UserId } from "../../../shared/ids";
import { adminProcedure, t } from "../trpc";

// User administration (docs/auth/auth-and-credentials-plan.md §6) — every procedure adminProcedure-gated.
// No UI.
export const userAdminRouter = t.router({
  listUsers: adminProcedure.query(({ ctx }) =>
    ctx.services.admin.listUsers({ username: ctx.username }),
  ),

  setRole: adminProcedure
    .input(z.object({ userId: brandedId<UserId>(), role: z.enum(["admin", "user"]) }))
    .mutation(({ ctx, input }) => ctx.services.admin.setRole({ username: ctx.username, ...input })),

  setEnabled: adminProcedure
    .input(z.object({ userId: brandedId<UserId>(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.setEnabled({ username: ctx.username, ...input }),
    ),

  // Server-side sessions: list a user's devices, kick one, or kick all (immediate, not at expiry).
  listSessions: adminProcedure
    .input(z.object({ userId: brandedId<UserId>() }))
    .query(({ ctx, input }) =>
      ctx.services.admin.listSessions({ username: ctx.username, ...input }),
    ),

  revokeSession: adminProcedure
    .input(z.object({ sessionId: brandedId<SessionId>() }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.revokeSession({ username: ctx.username, ...input }),
    ),

  revokeUserSessions: adminProcedure
    .input(z.object({ userId: brandedId<UserId>() }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.revokeUserSessions({ username: ctx.username, ...input }),
    ),

  // Local-password (AUTH_MODE=local) management. createUser mints a password account; resetPassword
  // sets a new password and kicks the user's sessions. The owner resets their own (seeded) password
  // via resetPassword on their own userId.
  createUser: adminProcedure
    .input(
      z.object({
        handle: z.string().min(1),
        password: z.string().min(8),
        role: z.enum(["admin", "user"]).default("user"),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.admin.createUser({ username: ctx.username, ...input }),
    ),

  resetPassword: adminProcedure
    .input(z.object({ userId: brandedId<UserId>(), newPassword: z.string().min(8) }))
    .mutation(({ ctx, input }) =>
      ctx.services.admin.resetPassword({ username: ctx.username, ...input }),
    ),
});
