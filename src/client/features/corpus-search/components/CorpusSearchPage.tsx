import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDiscover, useFind } from "../hooks/use-corpus-search";
import type { CorpusSearchState } from "../types";
import { DiscoverResults } from "./DiscoverResults";
import { FindResults } from "./FindResults";
import { SearchBar } from "./SearchBar";

// The corpus tool — the product. `state` (mode/q/rerank) lives in the URL (owned by the
// route), so a result is shareable and survives refresh. Two modes: Discover (characters
// grouped by matching conversations) and Find (raw cards + segments).
export function CorpusSearchPage({
  state,
  onChange,
}: {
  state: CorpusSearchState;
  onChange: (next: CorpusSearchState) => void;
}) {
  const discover = useDiscover(state.q, state.rerank, state.mode === "discover");
  const find = useFind(state.q, state.rerank, state.mode === "find");
  const active = state.mode === "discover" ? discover : find;

  function body(): ReactNode {
    if (state.q.length === 0) {
      return <p className="text-muted-foreground text-sm">Type a query above.</p>;
    }
    if (active.isLoading) {
      return <p className="text-muted-foreground text-sm">Searching…</p>;
    }
    if (active.isError) {
      return <p className="text-destructive text-sm">Search failed.</p>;
    }
    if (state.mode === "discover") {
      return <DiscoverResults characters={discover.data ?? []} />;
    }
    return <FindResults results={find.data ?? []} />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">corpus</h1>
        <Link to="/" className="text-muted-foreground text-sm hover:text-foreground">
          ← neo-tavern
        </Link>
      </header>
      <SearchBar state={state} onChange={onChange} />
      {body()}
    </main>
  );
}
