// Text helpers for building embedding inputs (cards + chat segments). Ported from
// card-curator extract.py (_clean_text, _normalize_placeholders, the card field builder).
// Pure. Token counting is a coarse chars/4 approximation everywhere — BGE-M3 has its own
// tokenizer but loading a second one buys nothing at this corpus scale (advisor call).

// Rough token estimate. Good enough for segmentation budgets + the degenerate-card filter.
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Strip HTML, collapse whitespace/newlines, trim per line. Port of extract.py:_clean_text. */
export function cleanText(text: string): string {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, "") // strip HTML tags
    .replace(/\n{3,}/g, "\n\n") // collapse 3+ newlines
    .replace(/[^\S\n]+/g, " ") // collapse runs of non-newline whitespace
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Replace ST placeholders. {{char}} → character name; {{user}} → the persona name (the
 *  user, not the literal "The User" — card-curator's choice was a stopgap). Case-insensitive.
 *  Port of extract.py:_normalize_placeholders. */
export function normalizePlaceholders(text: string, charName: string, userName: string): string {
  if (!text) return "";
  return text.replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
}

// Minimum embeddable text length. Tiny cards match everything moderately, so they're
// filtered from the index (still directly retrievable). card-curator config.py:76.
export const MIN_SEARCH_TEXT_TOKENS = 150;

// Only character-IDENTITY fields are embedded. card-curator's EMBED_FIELDS deliberately
// excludes mes_example / system_prompt / post_history_instructions / creator_notes — those
// are instructions/meta that dilute the identity signal and hurt retrieval. (They're still
// stored on character_versions + directly retrievable; just not in the embed text.)
export interface CardEmbedFields {
  name: string;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  firstMessage: string | null;
  alternateGreetings: string[];
  tags: string[];
}

// Field order = card-curator config.py:63 EMBED_FIELDS (order matters — last-token pooling
// weights later text less): name, tags, description, personality, scenario, first_mes, then
// the optional alternate_greetings. Port of extract.py:143-186.
export function buildCardEmbedText(card: CardEmbedFields, userName = "User"): string {
  const n = card.name;
  const field = (label: string, value: string | null): string | null => {
    if (!value) return null;
    const cleaned = cleanText(normalizePlaceholders(value, n, userName));
    return cleaned ? `${label}: ${cleaned}` : null;
  };

  const parts: (string | null)[] = [
    n ? `Name: ${n}` : null,
    card.tags.length > 0 ? `Tags: ${card.tags.join(", ")}` : null,
    field("Description", card.description),
    field("Personality", card.personality),
    field("Scenario", card.scenario),
    field("First Message", card.firstMessage),
  ];
  if (card.alternateGreetings.length > 0) {
    const joined = card.alternateGreetings
      .map((g) => cleanText(normalizePlaceholders(g, n, userName)))
      .filter((g) => g.length > 0)
      .join("\n---\n");
    if (joined) parts.push(`Alternate Greetings:\n${joined}`);
  }
  return parts.filter((p): p is string => p !== null).join("\n");
}
