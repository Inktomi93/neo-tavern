import { nanoid } from "nanoid";

// All row ids are nanoids (per docs/architecture/data-model.md conventions).
// Generic so a fresh id is branded at the mint seam: newId<PersonaId>() returns a
// PersonaId; bare newId() returns plain string. The `as T` is the one sanctioned
// mint-seam cast (see shared/ids.ts). The brand is type-only — runtime is unchanged.
export function newId<T extends string = string>(): T {
  return nanoid() as T;
}
