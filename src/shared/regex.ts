import { z } from "zod";

export const REGEX_PLACEMENTS = [
  "USER_INPUT",
  "AI_OUTPUT",
  "SLASH_COMMAND",
  "WORLD_INFO",
  "REASONING",
  "DISPLAY", // Used by the frontend only
] as const;

export type RegexPlacement = (typeof REGEX_PLACEMENTS)[number];

export const SubstituteFindRegex = {
  none: 0,
  raw: 1,
  escaped: 2,
} as const;

export type SubstituteFindRegex = (typeof SubstituteFindRegex)[keyof typeof SubstituteFindRegex];

export const regexScriptSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  findRegex: z.string(),
  replaceString: z.string(),
  placement: z.array(z.enum(REGEX_PLACEMENTS)),
  enabled: z.boolean().default(true),
  // Options mimicking ST
  markdownOnly: z.boolean().default(false),
  promptOnly: z.boolean().default(false),
  runOnEdit: z.boolean().default(false),
  trimStrings: z.array(z.string()).default([]),

  // FIX: Replaced deprecated nativeEnum with a union of the exact numeric literals
  substituteRegex: z
    .union([
      z.literal(SubstituteFindRegex.none),
      z.literal(SubstituteFindRegex.raw),
      z.literal(SubstituteFindRegex.escaped),
    ])
    .default(SubstituteFindRegex.none),

  // Min/Max depth for recursive generation
  minDepth: z.number().int().nullable().default(null),
  maxDepth: z.number().int().nullable().default(null),
});

export type RegexScript = z.infer<typeof regexScriptSchema>;
