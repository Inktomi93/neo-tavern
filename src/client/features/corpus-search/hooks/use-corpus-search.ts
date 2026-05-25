import { trpc } from "@/lib/trpc";

// Both hooks are always called (React rules), but only the active mode's query fetches
// (`enabled`). Each search costs a model embed (+ optional rerank pass), so it fires on a
// submitted, non-empty query — never per keystroke.
export function useDiscover(q: string, rerank: boolean, active: boolean) {
  return trpc.search.discover.useQuery(
    { queryText: q, rerank },
    { enabled: active && q.length > 0 },
  );
}

export function useFind(q: string, rerank: boolean, active: boolean) {
  return trpc.search.find.useQuery({ queryText: q, rerank }, { enabled: active && q.length > 0 });
}
