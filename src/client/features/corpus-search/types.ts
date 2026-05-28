import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/trpc/router";

// Inferred from the router (type-only across the boundary — the sanctioned client↔server
// seam). No manual duplication of the server's DiscoverCharacter / FindResult shapes.
type Outputs = inferRouterOutputs<AppRouter>;
export type DiscoverCharacter = Outputs["search"]["discover"][number];
export type FindResult = Outputs["search"]["find"][number];
export type CorpusHit = Outputs["search"]["corpus"][number];
export type SegmentSearchHit = Outputs["search"]["segments"][number];

export type SearchMode = "chats" | "segments" | "characters";

/** The submitted search, mirrored into the URL (?mode=&q=&rerank=) so results are shareable. */
export interface CorpusSearchState {
  mode: SearchMode;
  q: string;
  rerank: boolean;
}
