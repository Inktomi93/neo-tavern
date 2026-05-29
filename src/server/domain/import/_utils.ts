// Tiny pure-string utilities shared by the import parsers (card.ts + chat.ts).
// No DB, no I/O — keep this dependency-free.

/** Cast any value to string; non-string → empty string. */
export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Normalize empty / whitespace-only strings to null. */
export function nullIfEmpty(s: string): string | null {
  return s.trim().length > 0 ? s : null;
}
