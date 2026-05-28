// Shared chat event types for streaming, used by both domain and infra layers.

/** Discriminated delta events emitted on chatStreamEmitter("delta", …). */
export type ChatDeltaEvent =
  /** A chunk of the assistant's reply text. */
  | { chatId: string; kind: "text"; text: string }
  /** A chunk of reasoning/thinking content (hidden CoT, shown separately). */
  | { chatId: string; kind: "reasoning"; text: string };
