import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "../features/chat";

export const Route = createFileRoute("/chats/$id")({
  component: ChatPage,
});

function ChatPage() {
  const { id } = Route.useParams();

  return (
    <div
      className="mx-auto flex h-full w-full max-w-4xl flex-col shadow-sm border-x border-border/50 bg-background"
      data-testid="chat-page-route"
    >
      <ChatView chatId={id} />
    </div>
  );
}
