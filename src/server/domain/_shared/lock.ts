// In-process per-chat turn lock: only one generation may be in flight per chat, so
// two concurrent sends can't corrupt the SDK session_entries (the concurrency design
// in docs/data-model.md). Single-instance correct; a multi-instance deploy would
// promote this to a DB advisory lock (we're single-instance homelab).
const chains = new Map<string, Promise<unknown>>();

export function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(chatId) ?? Promise.resolve();
  const next = prior.then(fn, fn); // run fn after prior settles (success OR failure)
  // Keep the chain alive but swallow rejections so one failed turn doesn't poison the next.
  chains.set(
    chatId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}
