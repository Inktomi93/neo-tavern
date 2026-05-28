import { Link } from "@tanstack/react-router";
import { MessageSquare, Star } from "lucide-react";
import { trpc } from "@/lib/trpc";

export function ChatList() {
  const { data: chats, isLoading } = trpc.chat.list.useQuery();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded-lg bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!chats || chats.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground p-4 text-center">
        No active chats found. Start a new one!
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2" data-testid="chat-list-rail">
      {chats.map((chat) => (
        <Link
          key={chat.id}
          to="/chats/$id"
          params={{ id: chat.id }}
          className="flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground [&.active]:bg-secondary [&.active]:text-secondary-foreground"
          data-testid={`chat-link-${chat.id}`}
        >
          <div className="flex items-center gap-3 overflow-hidden">
            <MessageSquare className="size-4 shrink-0 opacity-70" />
            <div className="flex flex-col overflow-hidden">
              <span className="truncate font-medium">{chat.title || chat.characterName}</span>
              <span className="truncate text-xs opacity-70">
                {chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString() : "New"}
              </span>
            </div>
          </div>
          {chat.starred && <Star className="size-3 shrink-0 fill-amber-400 text-amber-400" />}
        </Link>
      ))}
    </div>
  );
}
