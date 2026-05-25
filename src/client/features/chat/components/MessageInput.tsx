import { useState } from "react";

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
      className="flex gap-2 border-zinc-800 border-t p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="flex-1 resize-none rounded bg-zinc-900 p-2 text-sm"
        rows={2}
        value={value}
        placeholder="Write your turn…"
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="submit"
        disabled={disabled}
        className="self-end rounded bg-zinc-100 px-4 py-2 text-sm text-zinc-900 disabled:opacity-50"
      >
        {disabled ? "…" : "Send"}
      </button>
    </form>
  );
}
