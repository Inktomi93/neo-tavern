// Build a chara_card_v3 JSON object from a character's LIVE structured fields (NOT `raw`, which is
// frozen at import — import/service.ts:165 is its only writer). The inverse of import/card.ts's
// reader: this shape, base64'd into a `ccv3` tEXt chunk by export/png.ts, re-parses cleanly.
// PURE: typed fields in → card object out; the export service maps DB rows to these inputs.

export interface ExportCardFields {
  name: string;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  /** [0] = first_mes; the rest = alternate_greetings. */
  greetings: string[];
  exampleMessages: string | null;
  systemPrompt: string | null;
  postHistoryInstructions: string | null;
  creatorNotes: string | null;
  tags: string[];
}

export interface ExportWorldEntry {
  /** ST `keys` (our `legacyKeys`). */
  keys: string[];
  content: string;
  enabled: boolean;
  priority: number;
}

/** Assemble the V3 card object. World entries (if any) become `character_book.entries`. */
export function buildCardV3(fields: ExportCardFields, entries: ExportWorldEntry[]): unknown {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: fields.name,
      description: fields.description ?? "",
      personality: fields.personality ?? "",
      scenario: fields.scenario ?? "",
      first_mes: fields.greetings[0] ?? "",
      mes_example: fields.exampleMessages ?? "",
      system_prompt: fields.systemPrompt ?? "",
      post_history_instructions: fields.postHistoryInstructions ?? "",
      creator_notes: fields.creatorNotes ?? "",
      alternate_greetings: fields.greetings.slice(1),
      tags: fields.tags,
      extensions: {},
      ...(entries.length > 0
        ? {
            character_book: {
              entries: entries.map((e) => ({
                keys: e.keys,
                content: e.content,
                enabled: e.enabled,
                insertion_order: e.priority,
              })),
            },
          }
        : {}),
    },
  };
}
