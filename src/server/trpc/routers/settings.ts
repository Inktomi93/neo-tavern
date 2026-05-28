import { z } from "zod";
import { publicProcedure, t } from "../trpc";

export const settingsRouter = t.router({
  getUserSettings: publicProcedure.query(({ ctx }) =>
    ctx.services.settings.getUserSettings({ username: ctx.username }),
  ),

  updateUserSettings: publicProcedure
    .input(
      z.object({
        config: z.any(),
        schemaVersion: z.number().int().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.services.settings.updateUserSettings({ username: ctx.username }, input),
    ),

  getGlobalSetting: publicProcedure
    .input(z.object({ key: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.services.settings.getGlobalSetting(input.key)),

  setGlobalSetting: publicProcedure
    .input(z.object({ key: z.string().min(1), value: z.any() }))
    .mutation(({ ctx, input }) => ctx.services.settings.setGlobalSetting(input.key, input.value)),
});
