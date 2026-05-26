// Feature front door (the only sanctioned barrel — see docs/architecture.md). Callers above the
// feature enter HERE, never its internals.

export type { ChatInspection, DebugService, DebugStats, IntegrityReport } from "./service";
export { createDebugService } from "./service";
