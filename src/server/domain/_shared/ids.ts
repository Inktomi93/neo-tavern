import { nanoid } from "nanoid";

// All row ids are nanoids (per docs/data-model.md conventions).
export function newId(): string {
  return nanoid();
}
