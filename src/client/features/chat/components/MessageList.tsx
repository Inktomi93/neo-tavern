import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { useChatUIStore } from "../store";
import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

export function MessageList({
  messages,
  chatId,
  targetSeq,
}: {
  messages: ChatMessage[];
  chatId: string;
  targetSeq?: number | undefined;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Pull from our new local Zustand store
  const isAutoScrollEnabled = useChatUIStore((state) => state.isAutoScrollEnabled);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120, // dynamic fallback height
    overscan: 5,
  });

  // Auto-scroll to bottom when new messages arrive, or scroll to specific seq
  useEffect(() => {
    if (targetSeq !== undefined && messages.length > 0 && parentRef.current) {
      const index = messages.findIndex((m) => m.seq >= targetSeq);
      if (index !== -1) {
        rowVirtualizer.scrollToIndex(index, { align: "center" });
      }
    } else if (isAutoScrollEnabled && messages.length > 0 && parentRef.current) {
      rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
  }, [messages, rowVirtualizer, isAutoScrollEnabled, targetSeq]);

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground text-sm">
        <p>No messages yet. Say something to start the story.</p>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full w-full overflow-y-auto px-4 py-6 sm:px-8"
      data-testid="chat-message-list"
      role="log"
      aria-live="polite"
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const message = messages[virtualRow.index];
          if (!message) return null;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-6"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <MessageBubble message={message} chatId={chatId} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
