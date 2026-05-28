import { z } from "zod";
import { regexScriptSchema } from "../regex";

export const userSettingsConfigSchema = z.object({
  regexScripts: z.array(regexScriptSchema).default([]),
});

export type UserSettingsConfig = z.infer<typeof userSettingsConfigSchema>;
