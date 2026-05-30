/**
 * Branded entity IDs — nominal types over `string`.
 *
 * Every primary key in the DB is a nanoid `string` (see `db/schema/ids.ts`).
 * Structurally they're all the same type, so nothing stops you from passing a
 * `characterId` where a `chatId` is expected — a whole class of bug TypeScript
 * can't see. Branding tags each id with a phantom marker so the compiler tells
 * them apart, with **zero runtime cost** (the brand is erased; it's still a
 * plain string at runtime).
 *
 * Lives in `shared/` so the brand flows end-to-end: the Drizzle schema columns
 * (`.$type<ChatId>()`), the domain/tRPC signatures, and the client (via the
 * inferred `AppRouter` types) all speak the same branded ids — `db`, `domain`,
 * `trpc`, and `client` can all import `shared`.
 *
 * Minting a fresh id: `newId<ChatId>()` (the generic `newId` in
 * `db/schema/ids.ts`). Crossing an untyped boundary (a raw request param, a
 * test fixture, a polymorphic `entityId`): `castId<ChatId>(raw)` — the explicit,
 * greppable seam where a bare string becomes branded. At the tRPC boundary use
 * `brandedId<ChatId>()` so Zod validates the string and hands back the brand.
 */

import { z } from "zod";

declare const brand: unique symbol;

/** A `string` tagged with a phantom `B` marker (erased at runtime). */
export type Branded<B extends string> = string & { readonly [brand]: B };

// --- Identity / auth ---------------------------------------------------------
export type UserId = Branded<"UserId">;
export type SessionId = Branded<"SessionId">;
export type UserCredentialId = Branded<"UserCredentialId">;

// --- Library entities --------------------------------------------------------
export type CharacterId = Branded<"CharacterId">;
export type CharacterVersionId = Branded<"CharacterVersionId">;
export type PersonaId = Branded<"PersonaId">;
export type PresetId = Branded<"PresetId">;
export type PresetVersionId = Branded<"PresetVersionId">;
export type WorldBookId = Branded<"WorldBookId">;
export type WorldEntryId = Branded<"WorldEntryId">;
export type TagId = Branded<"TagId">;
export type AssetId = Branded<"AssetId">;

// --- Chat / conversation -----------------------------------------------------
export type ChatId = Branded<"ChatId">;
export type MessageId = Branded<"MessageId">;
export type MessageVariantId = Branded<"MessageVariantId">;
export type ChatEventId = Branded<"ChatEventId">;
export type SessionEntryId = Branded<"SessionEntryId">;

// --- Corpus / vectors --------------------------------------------------------
export type CharacterEmbeddingId = Branded<"CharacterEmbeddingId">;
export type ChatDigestId = Branded<"ChatDigestId">;
export type ChatSegmentId = Branded<"ChatSegmentId">;

// --- Cross-cutting -----------------------------------------------------------
export type AuditLogId = Branded<"AuditLogId">;

/**
 * Brand a raw string as a specific id type. The ONE sanctioned cast — use it at
 * untyped seams (raw HTTP params, polymorphic `entityId`s stored as plain text,
 * test fixtures), never to paper over a real type mismatch.
 */
export function castId<T extends Branded<string>>(raw: string): T {
  return raw as T;
}

/**
 * A Zod schema for a branded id at a request boundary: validates a non-empty
 * string and types the parsed output as the brand. Usage:
 * `z.object({ chatId: brandedId<ChatId>() })`.
 */
export function brandedId<T extends Branded<string>>(): z.ZodType<T> {
  // Runtime: just a non-empty string. Type: the brand. The cast is the boundary
  // seam where an unbranded request string becomes a branded id (no transform —
  // the brand is type-only, so the runtime value is unchanged).
  return z.string().min(1) as unknown as z.ZodType<T>;
}
