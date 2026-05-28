import { Link } from "@tanstack/react-router";
import { MessageSquareShare } from "lucide-react";
import type { CorpusHit } from "../types";

export function ChatsResults({ results }: { results: CorpusHit[] }) {
  if (results.length === 0) {
    return <p className="text-muted-foreground text-sm">No matches.</p>;
  }
  return (
    <ul className="flex flex-col gap-4">
      {results.map((result) => (
        <li
          key={`${result.source}-${result.chatId}-${result.tier}-${result.blockIdx}`}
          className="rounded-xl border border-border/50 bg-card p-4 transition-all hover:border-primary/30 hover:shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="bg-primary/10 text-primary px-2 py-0.5 rounded text-xs uppercase tracking-wider font-semibold">
                {result.source === "digest"
                  ? `Story Arc (Tier ${result.tier})`
                  : "Verbatim Segment"}
              </span>
              <span className="text-muted-foreground text-sm font-medium">
                with {result.characterName}
              </span>
            </div>
            <Link
              to="/chats/$id"
              params={{ id: result.chatId }}
              search={{ seq: result.seqStart }}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-primary transition-colors bg-secondary/50 hover:bg-secondary px-2 py-1 rounded-md"
            >
              <MessageSquareShare className="size-3.5" />
              View in Chat
            </Link>
          </div>

          {result.topicAnchor && (
            <div className="mb-2 text-sm font-semibold text-foreground/90 bg-muted/30 p-2 rounded-lg border border-border/30 italic">
              {result.topicAnchor}
            </div>
          )}

          <ul className="text-muted-foreground text-sm leading-relaxed list-disc list-inside space-y-1 ml-1">
            {result.snippet
              .split("\n")
              .filter((line) =>
                result.topicAnchor ? line.trim() !== result.topicAnchor.trim() : true,
              )
              .filter((line) => line.trim().length > 0)
              .map((line) => (
                <li key={line} className="line-clamp-2">
                  {line.replace(/^-\s*/, "")}
                </li>
              ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
