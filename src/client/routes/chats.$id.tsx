import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "../features/chat";

export const Route = createFileRoute("/chats/$id")({
  validateSearch: (search: Record<string, unknown>): { seq?: number | undefined } => {
    const s = search as { seq?: unknown };
    let seq: number | undefined;
    if (typeof s.seq === "number") seq = s.seq;
    else if (typeof s.seq === "string") seq = parseInt(s.seq, 10);

    return seq !== undefined ? { seq } : {};
  },
  component: ChatPage,
});

function ChatPage() {
  const { id } = Route.useParams();
  const search = Route.useSearch();

  return (
    <div
      className="mx-auto flex h-full w-full max-w-4xl flex-col shadow-sm border-x border-border/50 bg-background"
      data-testid="chat-page-route"
    >
      <ChatView chatId={id} seq={search.seq} />
    </div>
  );
}
