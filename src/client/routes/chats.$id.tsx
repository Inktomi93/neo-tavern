import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "../features/chat";

export const Route = createFileRoute("/chats/$id")({
  component: ChatPage,
});

function ChatPage() {
  const { id } = Route.useParams();

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col">
      <ChatView chatId={id} />
    </main>
  );
}
