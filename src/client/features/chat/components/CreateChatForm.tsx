import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
      <Input
        placeholder="Chat title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Input
        placeholder="Character name"
        value={characterName}
        onChange={(event) => setCharacterName(event.target.value)}
      />
      <Textarea
        rows={3}
        placeholder="Character description"
        value={characterDescription}
        onChange={(event) => setCharacterDescription(event.target.value)}
      />
      <Button type="submit" disabled={create.isPending} className="self-start">
        {create.isPending ? "Creating…" : "New chat"}
      </Button>
    </form>
  );
}
