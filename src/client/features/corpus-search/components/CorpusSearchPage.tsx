import type { ReactNode } from "react";
import { useCorpus, useDiscover, useSegments } from "../hooks/use-corpus-search";
import type { CorpusSearchState } from "../types";
import { ChatsResults } from "./ChatsResults";
import { DiscoverResults } from "./DiscoverResults";
import { SearchBar } from "./SearchBar";
import { SegmentsResults } from "./SegmentsResults";

export function CorpusSearchPage({
  state,
  onChange,
}: {
  state: CorpusSearchState;
  onChange: (next: CorpusSearchState) => void;
}) {
  const discover = useDiscover(state.q, state.rerank, state.mode === "characters");
  const corpus = useCorpus(state.q, state.rerank, state.mode === "chats");
  const segments = useSegments(state.q, state.rerank, state.mode === "segments");

  let isLoading = false;
  let isError = false;
  if (state.mode === "characters") {
    isLoading = discover.isLoading;
    isError = discover.isError;
  }
  if (state.mode === "chats") {
    isLoading = corpus.isLoading;
    isError = corpus.isError;
  }
  if (state.mode === "segments") {
    isLoading = segments.isLoading;
    isError = segments.isError;
  }

  function body(): ReactNode {
    if (state.q.length === 0) {
      return <p className="text-muted-foreground text-sm">Type a query above.</p>;
    }
    if (isLoading) {
      return <p className="text-muted-foreground text-sm">Searching…</p>;
    }
    if (isError) {
      return <p className="text-destructive text-sm">Search failed.</p>;
    }

    if (state.mode === "characters") {
      return <DiscoverResults characters={discover.data ?? []} />;
    }
    if (state.mode === "chats") {
      return <ChatsResults results={corpus.data ?? []} />;
    }
    if (state.mode === "segments") {
      return <SegmentsResults results={segments.data ?? []} />;
    }

    return null;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-semibold text-3xl tracking-tight">Lorebook</h1>
      </header>
      <SearchBar state={state} onChange={onChange} />
      {body()}
    </main>
  );
}
