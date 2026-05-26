// Public API (front door) for the preset domain feature: CRUD over the presets / preset_versions
// triad with copy-on-write versioning (edit unpinned in place; edit a pinned version → fork). The
// prompt-manager UI (#43) drives this via the tRPC preset router.

export { createPresetService } from "./service";
export {
  type CreatePresetParams,
  type PresetDetail,
  PresetNotFoundError,
  PresetOperationError,
  type PresetService,
  type PresetSummary,
  type UpdatePresetParams,
} from "./types";
