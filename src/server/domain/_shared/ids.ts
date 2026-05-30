import { nanoid } from "nanoid";

// All row ids are nanoids (per docs/architecture/data-model.md conventions).
export function newId(): string {
  return nanoid();
}
