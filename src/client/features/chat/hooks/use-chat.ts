import { trpc } from "../../../lib/trpc";

export function useMessages(chatId: string) {
  return trpc.chat.messages.useQuery({ chatId });
}

export function useSendMessage(chatId: string) {
  const utils = trpc.useUtils();
  return trpc.chat.send.useMutation({
    // send returns the full message list (ok OR stale) — drop it straight into the
    // cache so the view re-syncs without a refetch round-trip.
    onSuccess: (result) => {
      utils.chat.messages.setData({ chatId }, result.messages);
    },
  });
}

export function useCreateChat() {
  return trpc.chat.create.useMutation();
}
