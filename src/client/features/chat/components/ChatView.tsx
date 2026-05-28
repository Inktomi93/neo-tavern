import { useMessages, useSendMessage } from "../hooks/use-chat";
import { ChatHeader } from "./ChatHeader";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";

export function ChatView({ chatId, seq }: { chatId: string; seq?: number | undefined }) {
  const messages = useMessages(chatId);
  const send = useSendMessage(chatId);

  const list = messages.data ?? [];
  // The optimistic-concurrency tip the server checks: our last-seen seq (0 = empty).
  const expectedSeq = list.at(-1)?.seq ?? 0;

  function handleSend(content: string) {
    send.mutate({ chatId, expectedSeq, content });
  }

  return (
    <section
      className="flex h-full flex-col relative"
      data-testid="chat-view-container"
      aria-label="Active Chat Session"
    >
      <ChatHeader chatId={chatId} />
      <div className="flex-1 overflow-hidden" data-testid="chat-history-region">
        {messages.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-muted-foreground animate-pulse">Loading memory...</span>
          </div>
        ) : (
          <MessageList messages={list} chatId={chatId} targetSeq={seq} />
        )}
      </div>
      <div
        className="shrink-0 p-4 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
        data-testid="chat-input-region"
      >
        <MessageInput disabled={send.isPending} onSend={handleSend} />
      </div>
    </section>
  );
}
