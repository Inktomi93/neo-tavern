import { z } from "zod";
import { appSettingsSchema } from "../../../shared/app-settings";
import { userSettingsSchema } from "../../../shared/user-settings";
import { adminProcedure, authedProcedure, t } from "../trpc";

export const settingsRouter = t.router({
  getUserSettings: authedProcedure.query(({ ctx }) =>
    ctx.services.settings.getUserSettings({ username: ctx.username }),
  ),

  updateUserSettings: authedProcedure
    .input(
      z.object({
        config: userSettingsSchema,
        schemaVersion: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.settings.updateUserSettings({ username: ctx.username }, input),
    ),

  getGlobalSetting: authedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.settings.getGlobalSetting(input.key)),

  setGlobalSetting: authedProcedure
    .input(z.object({ key: z.string().min(1), value: z.any() }))
    .mutation(({ ctx, input }) => ctx.services.settings.setGlobalSetting(input.key, input.value)),

  // Admin-only runtime config (the env-default-floor + DB-override knobs). Gated by adminProcedure
  // AND the service's own requireAdmin (defense in depth).
  getAppSettings: adminProcedure.query(({ ctx }) =>
    ctx.services.settings.getAppSettings({ username: ctx.username }),
  ),

  updateAppSettings: adminProcedure
    .input(appSettingsSchema)
    .mutation(({ ctx, input }) =>
      ctx.services.settings.updateAppSettings({ username: ctx.username }, input),
    ),
});
