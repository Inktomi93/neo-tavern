// Chat-service-internal constants shared across the verb modules (send / swipe / lifecycle /
// compaction). Kept here (not in any one verb file) because more than one module needs them and
// the import direction stays acyclic: constants ← every chat module, constants → nothing.

// The hidden "user" turn that elicits a generated opening (create's generateOpeningIfEmpty, and a
// greeting swipe). Never stored as a messages row — it only prompts the model to write the
// character's first message.
export const OPEN_SCENE_PROMPT =
  "[Open the scene: write your first message to me, in character — set the scene and greet me as your character would. Stay fully in character.]";

// Default steering for a manual `/compact` (compaction mode "off"). RP-tuned vs the SDK's generic
// coding-agent summary (which recalls early canon unreliably for tool-less RP — docs/subsystems/sdk-notes.md).
export const DEFAULT_COMPACT_INSTRUCTIONS =
  "Summarize the roleplay so far for continuation: preserve each character's voice and persona, the relationships and their current state, established facts and world details, unresolved threads, and the present scene/location. Be concise but lossless on canon — names, commitments, and specific details must survive.";

// Managed-compaction default: fire when the context is this fraction full (overridable per preset).
export const MANAGED_COMPACT_DEFAULT_PCT = 0.85;
