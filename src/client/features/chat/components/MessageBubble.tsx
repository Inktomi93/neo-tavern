import { ChevronLeft, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "../types";

const roleplaySchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...((defaultSchema.attributes as { span?: string[] })?.span || []),
      "className",
      "data-character",
    ],
    div: [
      ...((defaultSchema.attributes as { div?: string[] })?.div || []),
      "className",
      "data-role",
    ],
  },
};

export function MessageBubble({ message, chatId }: { message: ChatMessage; chatId: string }) {
  const isUser = message.role === "user";

  const selectVariant = trpc.chat.selectVariant.useMutation();
  const swipe = trpc.chat.swipe.useMutation();

  const variantCount = message.variantCount ?? 1;
  const currentVariantIdx = message.activeVariantIdx ?? 0;

  const handleSwipe = (direction: -1 | 1) => {
    if (variantCount <= 1) return;
    let nextIdx = currentVariantIdx + direction;
    if (nextIdx < 0) nextIdx = variantCount - 1;
    if (nextIdx >= variantCount) nextIdx = 0;

    selectVariant.mutate({
      chatId,
      messageId: message.id,
      variantIdx: nextIdx,
    });
  };

  const handleGenerateSwipe = () => {
    swipe.mutate({
      chatId,
      expectedSeq: message.seq,
    });
  };

  return (
    <section
      className={cn("flex w-full flex-col gap-1", isUser ? "items-end" : "items-start")}
      data-testid={`msg-bubble-${message.id || message.seq}`}
      aria-label={`Message from ${message.role}`}
    >
      <span
        className="px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70"
        aria-hidden="true"
      >
        {message.role}
      </span>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-5 py-3 text-[15px] leading-relaxed shadow-sm sm:max-w-[75%]",
          isUser
            ? "rounded-tr-sm bg-primary text-primary-foreground"
            : "rounded-tl-sm border bg-card text-card-foreground",
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, roleplaySchema]]}
          components={{
            p: ({ ...props }) => <p className="mb-2 last:mb-0" {...props} />,
            em: ({ ...props }) => <em className="font-serif italic opacity-90" {...props} />,
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>

      {!isUser && (
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground opacity-50 transition-opacity hover:opacity-100">
          <div className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
              onClick={() => handleSwipe(-1)}
              disabled={variantCount <= 1}
              aria-label="Previous variant"
            >
              <ChevronLeft className="size-3" />
            </button>
            <span className="text-[10px] font-medium w-6 text-center">
              {currentVariantIdx + 1}/{variantCount}
            </span>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
              onClick={() => handleSwipe(1)}
              disabled={variantCount <= 1}
              aria-label="Next variant"
            >
              <ChevronRight className="size-3" />
            </button>
          </div>
          <button
            type="button"
            onClick={handleGenerateSwipe}
            className="text-[10px] font-medium hover:text-foreground"
            disabled={swipe.isPending}
          >
            {swipe.isPending ? "Generating..." : "Swipe to Regenerate"}
          </button>
        </div>
      )}
    </section>
  );
}
