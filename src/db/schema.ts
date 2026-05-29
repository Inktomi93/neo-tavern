// Drizzle schema — the v1 spec from docs/data-model.md, machine-of-record.
// Layer rule (docs/architecture.md): `db` imports only `shared` + externals; never
// `server`/`client`. Column names are explicit snake_case (no `casing` inference —
// drizzle's casing has live bugs; explicit is deterministic).

export * from "./schema/assets";
export * from "./schema/audit";
export * from "./schema/characters";
export * from "./schema/chats";
export * from "./schema/config";
export * from "./schema/custom-types";
export * from "./schema/relations";
export * from "./schema/search";
export * from "./schema/session";
export * from "./schema/tags";
export * from "./schema/tenancy";
export * from "./schema/world";
