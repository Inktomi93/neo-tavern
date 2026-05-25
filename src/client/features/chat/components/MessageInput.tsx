import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function MessageInput({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (content: string) => void;
}) {
  const [value, setValue] = useState("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }
    onSend(trimmed);
    setValue("");
  }

  return (
    <form
      className="flex gap-2 border-t p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        className="min-h-0 flex-1"
        rows={2}
        value={value}
        placeholder="Write your turn…"
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" disabled={disabled} className="self-end">
        {disabled ? "…" : "Send"}
      </Button>
    </form>
  );
}
