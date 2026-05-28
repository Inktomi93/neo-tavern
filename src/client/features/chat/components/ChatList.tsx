import { Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
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
    <ScrollArea className="h-[400px] w-full pr-4">
      <div className="flex flex-col gap-2" data-testid="chat-list-rail">
        {chats.map((chat) => (
          <Link
            key={chat.id}
            to="/chats/$id"
            params={{ id: chat.id }}
            className="flex items-center justify-between rounded-xl border border-transparent px-4 py-3 text-sm transition-all hover:bg-card hover:border-border/50 hover:shadow-sm [&.active]:bg-primary/10 [&.active]:border-primary/20"
            data-testid={`chat-link-${chat.id}`}
          >
            <div className="flex items-center gap-4 overflow-hidden">
              <Avatar className="size-10 border border-border/50 shadow-sm">
                <AvatarFallback className="bg-muted text-muted-foreground font-semibold">
                  {(chat.title || chat.characterName || "C").charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col overflow-hidden">
                <span className="truncate font-semibold text-foreground/90">
                  {chat.title || chat.characterName || "Untitled Chat"}
                </span>
                <span className="truncate text-xs font-medium text-muted-foreground mt-0.5">
                  {chat.updatedAt ? new Date(chat.updatedAt).toLocaleDateString() : "New"}
                </span>
              </div>
            </div>
            {chat.starred && (
              <Star className="size-4 shrink-0 fill-amber-400 text-amber-400 drop-shadow-sm" />
            )}
          </Link>
        ))}
      </div>
    </ScrollArea>
  );
}
