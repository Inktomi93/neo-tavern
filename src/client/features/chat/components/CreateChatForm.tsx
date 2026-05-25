import { useState } from "react";
import { useCreateChat } from "../hooks/use-chat";

export function CreateChatForm({ onCreated }: { onCreated: (chatId: string) => void }) {
  const create = useCreateChat();
  const [title, setTitle] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [characterDescription, setCharacterDescription] = useState("");

  function submit() {
    if (create.isPending) {
      return;
    }
    create.mutate(
      { title, characterName, characterDescription },
      { onSuccess: (result) => onCreated(result.chatId) },
    );
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        className="rounded bg-zinc-900 p-2 text-sm"
        placeholder="Chat title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        className="rounded bg-zinc-900 p-2 text-sm"
        placeholder="Character name"
        value={characterName}
        onChange={(event) => setCharacterName(event.target.value)}
      />
      <textarea
        className="resize-none rounded bg-zinc-900 p-2 text-sm"
        rows={3}
        placeholder="Character description"
        value={characterDescription}
        onChange={(event) => setCharacterDescription(event.target.value)}
      />
      <button
        type="submit"
        disabled={create.isPending}
        className="rounded bg-zinc-100 px-4 py-2 text-sm text-zinc-900 disabled:opacity-50"
      >
        {create.isPending ? "Creating…" : "New chat"}
      </button>
    </form>
  );
}
