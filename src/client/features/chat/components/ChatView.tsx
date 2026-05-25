import { useMessages, useSendMessage } from "../hooks/use-chat";
import { MessageInput } from "./MessageInput";
import { MessageList } from "./MessageList";

export function ChatView({ chatId }: { chatId: string }) {
  const messages = useMessages(chatId);
  const send = useSendMessage(chatId);

  const list = messages.data ?? [];
  // The optimistic-concurrency tip the server checks: our last-seen seq (0 = empty).
  const expectedSeq = list.at(-1)?.seq ?? 0;
  const isStale = send.data?.status === "stale";

  function handleSend(content: string) {
    send.mutate({ chatId, expectedSeq, content });
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex-1 overflow-y-auto">
        {messages.isLoading ? (
          <p className="p-4 text-muted-foreground text-sm">loading…</p>
        ) : (
          <MessageList messages={list} />
        )}
        {isStale ? (
          <p className="px-4 text-amber-400 text-sm">
            This chat advanced elsewhere — your view was re-synced; resend your message.
          </p>
        ) : null}
        {send.isError ? (
          <p className="px-4 text-sm text-red-400">Turn failed — try again.</p>
        ) : null}
      </div>
      <MessageInput disabled={send.isPending} onSend={handleSend} />
    </div>
  );
}
