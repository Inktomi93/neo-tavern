import { createFileRoute } from "@tanstack/react-router";
import { CorpusSearchPage, type CorpusSearchState } from "../features/corpus-search";

// The corpus search/discover surface. Search state (mode/q/rerank) lives in the URL so
// results are shareable + survive refresh; validateSearch normalizes the raw query string.
export const Route = createFileRoute("/corpus")({
  validateSearch: (search: Record<string, unknown>): CorpusSearchState => {
    // Cast to a typed shape so dot access satisfies both tsc (no index-signature access) and
    // biome (no literal computed keys) — the conventions.md fix for external/dynamic data.
    const s = search as { mode?: unknown; q?: unknown; rerank?: unknown };
    return {
      mode: s.mode === "find" ? "find" : "discover",
      q: typeof s.q === "string" ? s.q : "",
      rerank: s.rerank === true || s.rerank === "true",
    };
  },
  component: CorpusRoute,
});

function CorpusRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <CorpusSearchPage state={search} onChange={(next) => navigate({ search: next })} />;
}
