import type { ChatMessage } from "../types";

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  if (messages.length === 0) {
    return <p className="p-4 text-muted-foreground text-sm">No messages yet — say something.</p>;
  }

  return (
    <ul className="flex flex-col gap-3 p-4">
      {messages.map((message) => (
        <li key={message.id} className={message.role === "user" ? "self-end" : "self-start"}>
          <div className="max-w-md rounded-lg bg-card px-3 py-2 text-card-foreground text-sm">
            <span className="mb-1 block text-muted-foreground text-xs">{message.role}</span>
            <span className="whitespace-pre-wrap">{message.content}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
