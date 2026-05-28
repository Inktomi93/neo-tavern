import type { Db } from "../../../db/client";
import { createBranch } from "./branch";
import { createCompaction } from "./compaction";
import { type ChatServiceDeps, createChatContext } from "./context";
import { createLifecycle } from "./lifecycle";
import { createRead } from "./read";
import { createSend } from "./send";
import { createSwipe } from "./swipe";
import type { ChatService } from "./types";

export type { ChatServiceDeps };

// Composition root for the chat domain feature. Builds the shared substrate (createChatContext)
// once, instantiates each verb group over it, wires the one verb-to-verb dependency
// (send → runCompaction) explicitly, and returns the ChatService the tRPC router calls. Each verb's
// implementation lives in its own sibling file (context / send / swipe / branch / lifecycle /
// compaction / read); this file owns only the wiring. The (db, deps) signature + the returned
// ChatService shape are the stable public contract — index.ts re-exports just createChatService.
export function createChatService(db: Db, deps: ChatServiceDeps = {}): ChatService {
  const ctx = createChatContext(db, deps);

  const { runCompaction, compact } = createCompaction(ctx);
  const { send } = createSend(ctx, { runCompaction });
  const { swipe, selectVariant } = createSwipe(ctx);
  const { forkChat, setProvider } = createBranch(ctx);
  const {
    create,
    editMessage,
    delete: deleteChat,
    updateTitle,
    star,
    archive,
  } = createLifecycle(ctx);
  const { listChats, getChat, listMessages, previewAssembly } = createRead(ctx);

  return {
    create,
    listChats,
    getChat,
    previewAssembly,
    listMessages,
    send,
    setProvider,
    forkChat,
    swipe,
    selectVariant,
    editMessage,
    compact,
    delete: deleteChat,
    updateTitle,
    star,
    archive,
  };
}
