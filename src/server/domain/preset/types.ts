import type { PromptConfig } from "../../../shared/prompt-config";
import { DomainNotFoundError, DomainOperationError } from "../_shared/errors";

// Preset domain types. A preset is the identity/content-version/pin triad (like characters):
// the `presets` row is mutable identity (name/kind/currentVersionId); each `preset_versions` row
// is an immutable `config` snapshot. Copy-on-write: editing a version no chat/message pins mutates
// it in place; editing a PINNED version forks `v=max+1` + repoints currentVersionId — so
// `messages.presetVersionId` stays an immutable record of the structure that produced each turn.

export interface PresetSummary {
  id: string;
  name: string;
  kind: string; // free-text library label (NOT a structural type)
  currentVersionId: string | null;
  version: number | null; // the current version's number
  createdAt: number;
  updatedAt: number;
}

export interface PresetDetail extends PresetSummary {
  config: PromptConfig; // the current version's parsed config blob
  schemaVersion: number;
  /** true when the current version is referenced by a chat/message → the next config edit FORKS
   *  a new version (copy-on-write) rather than mutating in place. The editor surfaces this. */
  pinned: boolean;
}

export interface CreatePresetParams {
  username: string;
  name: string;
  kind: string;
  // `| undefined` (not bare `?`) so a zod `.optional()` value spread from the router fits under
  // exactOptionalPropertyTypes (docs/conventions.md). omitted → seeded from DEFAULT_PROMPT_CONFIG.
  config?: PromptConfig | undefined;
}

export interface UpdatePresetParams {
  username: string;
  presetId: string;
  // identity edits (name/kind) are always in place — they're not provenance. `| undefined` for the
  // exactOptionalPropertyTypes ↔ zod-optional spread (docs/conventions.md).
  name?: string | undefined;
  kind?: string | undefined;
  // copy-on-write: in place if the current version is unpinned, else fork.
  config?: PromptConfig | undefined;
}

export interface PresetService {
  create(params: CreatePresetParams): Promise<PresetDetail>;
  list(params: { username: string }): Promise<PresetSummary[]>;
  /** One owned preset + its current config. Throws PresetNotFoundError if missing/unowned. */
  get(params: { username: string; presetId: string }): Promise<PresetDetail>;
  update(params: UpdatePresetParams): Promise<PresetDetail>;
  /** Hard delete. Throws PresetOperationError("preset_in_use") if any version is pinned by a
   *  chat/message (the RESTRICT FK) — archive-don't-delete, like characters. */
  remove(params: { username: string; presetId: string }): Promise<{ deleted: true }>;
}

// Missing or not owned by the caller → the transport maps this to NOT_FOUND (domain can't import
// @trpc/server — wrong direction). Mirrors ChatNotFoundError.
export class PresetNotFoundError extends DomainNotFoundError {
  constructor(presetId: string) {
    super("Preset", presetId);
  }
}

// An operation invalid for the preset's current state. `reason` lets the transport pick the code
// without importing @trpc/server. preset_in_use = a delete blocked by a chat/message pin.
export type PresetOpReason = "preset_in_use";
export class PresetOperationError extends DomainOperationError {
  readonly reason: PresetOpReason;
  constructor(reason: PresetOpReason, message: string) {
    super(reason, message);
    this.reason = reason;
  }
}
