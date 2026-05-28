import { Cpu, FileText, Settings2 } from "lucide-react";
import { trpc } from "../../../lib/trpc";

export function ChatHeader({ chatId }: { chatId: string }) {
  const chat = trpc.chat.get.useQuery({ chatId });

  // These queries load the model catalogs and presets for the pickers
  const sdkModels = trpc.models.useQuery();
  const rawModels = trpc.rawModels.useQuery();
  // const presets = trpc.preset.list.useQuery();

  const setProvider = trpc.chat.setProvider.useMutation({
    onSuccess: () => chat.refetch(),
  });

  if (!chat.data) {
    return (
      <header className="h-14 border-b bg-card animate-pulse" data-testid="chat-header-loading" />
    );
  }

  const currentModel = chat.data.model || "Default Model";
  // The backend passes the context window limit and usage via turn metadata.
  const contextFillPercent = Math.min(
    100,
    Math.round(((chat.data.totalTokensIn || 0) / 8192) * 100),
  );
  const availableModels =
    chat.data.api === "agent-sdk" ? sdkModels.data || [] : rawModels.data || [];

  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60"
      data-testid="chat-header"
    >
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold tracking-tight">
          {chat.data.title || chat.data.characterName}
        </h1>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground uppercase">
          {chat.data.api}
        </span>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {/* Context Meter */}
        <div
          className="hidden sm:flex items-center gap-2"
          title="Context Window Fill"
          data-testid="context-meter"
        >
          <Cpu className="size-4" aria-hidden="true" />
          <div
            className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-valuenow={contextFillPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: `${contextFillPercent}%` }}
            />
          </div>
        </div>

        {/* Model Picker Trigger */}
        <div className="relative flex items-center">
          <Settings2
            className="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none"
            aria-hidden="true"
          />
          <select
            className="h-8 w-32 appearance-none truncate rounded-md border bg-card pl-8 pr-8 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="model-picker-select"
            aria-label="Change AI Model"
            value={currentModel}
            onChange={(e) =>
              setProvider.mutate({
                chatId,
                api: chat.data.api,
                source: chat.data.source,
                model: e.target.value,
              })
            }
            disabled={setProvider.isPending}
          >
            <option value={currentModel}>{currentModel}</option>
            {(Array.isArray(availableModels) ? availableModels : availableModels.available).map(
              (m) => (
                <option key={m.id} value={m.id}>
                  {("label" in m
                    ? (m as { label?: string }).label
                    : (m as { name?: string }).name) || m.id}
                </option>
              ),
            )}
          </select>
        </div>

        {/* Preset Picker Trigger */}
        <button
          type="button"
          className="hidden sm:flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="preset-picker-trigger"
          aria-label="Change Prompt Preset"
        >
          <FileText className="size-3.5" aria-hidden="true" />
          <span className="font-medium">Default Preset</span>
        </button>
      </div>
    </header>
  );
}
