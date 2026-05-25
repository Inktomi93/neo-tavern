import type { FindResult } from "../types";

function ResultRow({ result }: { result: FindResult }) {
  if (result.kind === "character") {
    return (
      <li className="rounded-md border border-border bg-card px-3 py-2">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">character</span>{" "}
        <span className="font-medium">{result.name}</span>
        {result.tags.length > 0 && (
          <span className="text-muted-foreground text-sm">
            {" "}
            · {result.tags.slice(0, 4).join(", ")}
          </span>
        )}
      </li>
    );
  }
  return (
    <li className="rounded-md border border-border bg-card px-3 py-2">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {result.characterName} · conversation
      </span>
      <p className="mt-0.5 text-muted-foreground text-sm">{result.snippet.trim()}…</p>
    </li>
  );
}

export function FindResults({ results }: { results: FindResult[] }) {
  if (results.length === 0) {
    return <p className="text-muted-foreground text-sm">No matches.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {results.map((result) => (
        <ResultRow key={result.entityId} result={result} />
      ))}
    </ul>
  );
}
