import { Link } from "@tanstack/react-router";
import { MessageSquareShare } from "lucide-react";
import type { SegmentSearchHit } from "../types";

export function SegmentsResults({ results }: { results: SegmentSearchHit[] }) {
  if (results.length === 0) {
    return <p className="text-muted-foreground text-sm">No matches.</p>;
  }
  return (
    <ul className="flex flex-col gap-4">
      {results.map((result) => (
        <li
          key={`${result.chatId}-${result.blockIdx}`}
          className="rounded-xl border border-border/50 bg-card p-4 transition-all hover:border-primary/30 hover:shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="bg-primary/10 text-primary px-2 py-0.5 rounded text-xs uppercase tracking-wider font-semibold">
                Verbatim Segment
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

          <p className="text-muted-foreground text-sm leading-relaxed line-clamp-3 italic bg-muted/20 p-3 rounded-lg border-l-2 border-primary/40">
            "{result.snippet.trim()}"
          </p>
        </li>
      ))}
    </ul>
  );
}
