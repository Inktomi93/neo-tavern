import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CorpusSearchState, SearchMode } from "../types";

const PLACEHOLDER: Record<SearchMode, string> = {
  chats: "search the lore and story arcs...",
  segments: "search exact verbatim chat quotes...",
  characters: "search characters by traits or name...",
};

// Controlled by the route's URL state. The input keeps a local DRAFT; submit (Enter / button)
// commits it to the URL via onChange, which triggers the query. Toggling mode/rerank re-runs
// the last submitted query immediately.
export function SearchBar({
  state,
  onChange,
}: {
  state: CorpusSearchState;
  onChange: (next: CorpusSearchState) => void;
}) {
  const [draft, setDraft] = useState(state.q);

  return (
    <form
      className="flex flex-col gap-6 p-6 rounded-2xl border bg-card/40 shadow-sm backdrop-blur-xl w-full"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ ...state, q: draft.trim(), rerank: true }); // Auto-enable rerank for simplicity
      }}
    >
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Search Input */}
        <div className="relative flex-1 group">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Search className="size-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
          </div>
          <Input
            className="w-full pl-12 pr-4 h-14 rounded-xl border-border/50 bg-background/50 shadow-inner text-base transition-all focus-visible:ring-primary/30 focus-visible:border-primary/50"
            placeholder={PLACEHOLDER[state.mode]}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        {/* Search Button */}
        <Button
          type="submit"
          size="lg"
          className="h-14 px-8 rounded-xl font-semibold shadow-md hover:shadow-lg transition-all"
        >
          Search
        </Button>
      </div>

      {/* Search Mode Selector */}
      <div className="flex items-center gap-2 bg-background/40 p-1 rounded-lg self-start border border-border/30">
        <button
          type="button"
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            state.mode === "chats"
              ? "bg-card shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onChange({ ...state, mode: "chats", rerank: true })}
        >
          Chats
        </button>
        <button
          type="button"
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            state.mode === "segments"
              ? "bg-card shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onChange({ ...state, mode: "segments", rerank: true })}
        >
          Chat Segments
        </button>
        <button
          type="button"
          className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
            state.mode === "characters"
              ? "bg-card shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onChange({ ...state, mode: "characters", rerank: true })}
        >
          Characters
        </button>
      </div>
    </form>
  );
}
