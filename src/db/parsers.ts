// Read-boundary parsers for JSON columns. Drizzle's `.$type<string[]>()` is an UNCHECKED assertion:
// it tells TypeScript the column's shape but never validates the bytes actually stored. These helpers
// coerce a raw column value to its declared shape at the row→view seam, degrading a malformed or
// legacy row to `null` (via `.catch`) instead of letting a bad value flow downstream typed as a lie.
// They replace the `as string[]` casts that previously stood in for validation.

import { z } from "zod";

const stringArrayOrNull = z.array(z.string()).nullable().catch(null);

/**
 * Parse a JSON `string[]` column (greetings, tags, legacyKeys, keywords). Returns `null` for `null`,
 * `undefined`, or any value that is not an array of strings.
 */
export function parseStringArray(value: unknown): string[] | null {
  return stringArrayOrNull.parse(value);
}
