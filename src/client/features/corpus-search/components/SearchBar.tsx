import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CorpusSearchState, SearchMode } from "../types";

const PLACEHOLDER: Record<SearchMode, string> = {
  discover: "who have I…  (e.g. comforting someone crying)",
  find: "search the corpus…",
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
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ ...state, q: draft.trim() });
      }}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={state.mode === "discover" ? "default" : "ghost"}
          onClick={() => onChange({ ...state, mode: "discover" })}
        >
          Discover
        </Button>
        <Button
          type="button"
          size="sm"
          variant={state.mode === "find" ? "default" : "ghost"}
          onClick={() => onChange({ ...state, mode: "find" })}
        >
          Find
        </Button>
        <label className="ml-auto flex items-center gap-1.5 text-muted-foreground text-sm">
          <input
            type="checkbox"
            checked={state.rerank}
            onChange={(event) => onChange({ ...state, rerank: event.target.checked })}
          />
          better ranking
        </label>
      </div>
      <div className="flex gap-2">
        <Input
          placeholder={PLACEHOLDER[state.mode]}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit">Search</Button>
      </div>
    </form>
  );
}
