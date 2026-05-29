// Serialize a chat's canon to SillyTavern chat-JSONL — the inverse of import/chat.ts's parser.
// Dates are emitted as epoch-ms numbers (parseStDate reads ≥1e12 as ms, so they round-trip). Swipes
// are written only when a message has >1 variant (matching the parser's `swipes.length > 1` rule).
// PURE: typed canon in → JSONL string out; the export service maps DB rows to these inputs.

export interface ExportChatMeta {
  characterName: string;
  userName: string | null;
  createDate: number | null;
  parentRef?: string | null;
  notePrompt?: string | null;
}

export interface ExportVariant {
  content: string;
  model: string | null;
  provider: string | null;
  tokensOut: number | null;
  genStarted: number | null;
  genFinished: number | null;
}

export interface ExportMessage {
  role: "user" | "assistant" | "system";
  content: string;
  sendDate: number | null;
  model: string | null;
  provider: string | null;
  tokensOut: number | null;
  genStarted: number | null;
  genFinished: number | null;
  activeVariantIdx: number | null;
  /** All swipes (verbatim), incl. the active one. Length ≤ 1 → no swipe arrays emitted. */
  variants: ExportVariant[];
}

export function buildChatJsonl(meta: ExportChatMeta, messages: ExportMessage[]): string {
  const header = {
    user_name: meta.userName,
    character_name: meta.characterName,
    create_date: meta.createDate,
    chat_metadata: {
      ...(meta.parentRef ? { main_chat: meta.parentRef } : {}),
      ...(meta.notePrompt ? { note_prompt: meta.notePrompt } : {}),
    },
  };

  const lines = [JSON.stringify(header)];
  for (const m of messages) {
    const hasVariants = m.variants.length > 1;
    const line = {
      name: m.role === "user" ? (meta.userName ?? "User") : meta.characterName,
      is_user: m.role === "user",
      is_system: m.role === "system",
      mes: m.content,
      send_date: m.sendDate ?? meta.createDate,
      extra: { model: m.model, api: m.provider, token_count: m.tokensOut },
      gen_started: m.genStarted,
      gen_finished: m.genFinished,
      // Swipe arrays only when >1 variant (matches the parser's `swipes.length > 1` gate).
      ...(hasVariants
        ? {
            swipes: m.variants.map((v) => v.content),
            swipe_id: m.activeVariantIdx ?? 0,
            swipe_info: m.variants.map((v) => ({
              extra: { model: v.model, api: v.provider, token_count: v.tokensOut },
              gen_started: v.genStarted,
              gen_finished: v.genFinished,
            })),
          }
        : {}),
    };
    lines.push(JSON.stringify(line));
  }
  return `${lines.join("\n")}\n`;
}
