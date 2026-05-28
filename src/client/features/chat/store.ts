import { create } from "zustand";

interface ChatUIState {
  // UI Ephemeral State (Never hits the DB)
  editingMessageId: string | null;
  isAutoScrollEnabled: boolean;

  // Actions
  setEditingMessage: (id: string | null) => void;
  setAutoScroll: (enabled: boolean) => void;
}

// Best Practice: The store is scoped EXCLUSIVELY to the Chat feature slice.
// It is NOT global. This prevents unrelated components (like the Corpus Search)
// from re-rendering when the chat UI state changes.
export const useChatUIStore = create<ChatUIState>()((set) => ({
  editingMessageId: null,
  isAutoScrollEnabled: true,

  setEditingMessage: (id) => set({ editingMessageId: id }),
  setAutoScroll: (enabled) => set({ isAutoScrollEnabled: enabled }),
}));
