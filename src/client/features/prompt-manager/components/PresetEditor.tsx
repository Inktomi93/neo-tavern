import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PromptConfig, PromptSection } from "../../../../shared/prompt-config";

export function PresetEditor({
  initialConfig,
  onSave,
}: {
  initialConfig: PromptConfig;
  onSave: (config: PromptConfig) => void;
}) {
  const [config, setConfig] = useState<PromptConfig>(initialConfig);

  const updateSection = (index: number, partial: Partial<PromptSection>) => {
    const newSections = [...config.sections];
    newSections[index] = { ...newSections[index], ...partial } as PromptSection;
    setConfig({ ...config, sections: newSections });
  };

  const reorderSection = (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= config.sections.length) return;

    const newSections = [...config.sections];
    const temp = newSections[index] as PromptSection;
    newSections[index] = newSections[targetIdx] as PromptSection;
    newSections[targetIdx] = temp;

    setConfig({ ...config, sections: newSections });
  };

  return (
    <div className="flex flex-col gap-6" data-testid="preset-editor-container">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <h2 className="text-xl font-bold tracking-tight">Prompt Manager</h2>
          <p className="text-muted-foreground text-sm">
            Configure exactly how context is assembled before it reaches the model.
          </p>
        </div>
        <Button onClick={() => onSave(config)} data-testid="preset-save-btn">
          Save Preset
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {config.sections.map((section, idx: number) => {
          if (section.type === "boundary") {
            return (
              <div
                key={section.id}
                className="relative flex items-center py-6"
                data-testid="preset-cache-boundary"
              >
                <div className="flex-grow border-t-2 border-dashed border-primary/40"></div>
                <span className="shrink-0 bg-background px-4 text-xs font-bold uppercase tracking-widest text-primary">
                  Cache Boundary (Static Above, Dynamic Below)
                </span>
                <div className="flex-grow border-t-2 border-dashed border-primary/40"></div>
              </div>
            );
          }

          return (
            <div
              key={section.id}
              className={`flex flex-col gap-3 rounded-xl border p-4 shadow-sm transition-all ${
                section.enabled ? "bg-card" : "bg-muted/30 opacity-70"
              }`}
              data-testid={`preset-section-${section.id}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{section.name || section.id}</span>
                  <span className="rounded bg-secondary/50 px-2 py-0.5 text-[10px] font-medium uppercase text-secondary-foreground">
                    {section.type}
                  </span>
                  {section.type === "literal" && (
                    <span className="rounded bg-accent px-2 py-0.5 text-[10px] font-medium uppercase text-accent-foreground">
                      {section.role}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  {/* Reorder Controls */}
                  <div className="flex items-center gap-1 border-r pr-4">
                    <button
                      type="button"
                      onClick={() => reorderSection(idx, -1)}
                      disabled={idx === 0}
                      className="rounded bg-muted px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                      aria-label="Move Up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => reorderSection(idx, 1)}
                      disabled={idx === config.sections.length - 1}
                      className="rounded bg-muted px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                      aria-label="Move Down"
                    >
                      ↓
                    </button>
                  </div>

                  {/* Enable Toggle */}
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor={`toggle-${section.id}`}
                      className="text-xs font-medium text-muted-foreground cursor-pointer"
                    >
                      {section.enabled ? "Enabled" : "Disabled"}
                    </label>
                    <input
                      id={`toggle-${section.id}`}
                      type="checkbox"
                      checked={section.enabled}
                      onChange={(e) => updateSection(idx, { enabled: e.target.checked })}
                      className="h-4 w-4 cursor-pointer accent-primary"
                      data-testid={`toggle-${section.id}`}
                    />
                  </div>
                </div>
              </div>

              {section.type === "literal" && section.enabled && (
                <div className="mt-2 overflow-hidden rounded-md border focus-within:ring-2 focus-within:ring-ring">
                  <CodeMirror
                    value={section.content}
                    height="auto"
                    extensions={[markdown()]}
                    theme="dark"
                    onChange={(val) => updateSection(idx, { content: val })}
                    className="text-[13px]"
                    data-testid={`editor-${section.id}`}
                  />
                </div>
              )}

              {section.type === "marker" && section.enabled && (
                <div className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
                  <div>
                    Injects{" "}
                    <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                      {section.marker}
                    </code>
                  </div>
                  {section.scope && (
                    <div>
                      Scope:{" "}
                      <code className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                        {section.scope}
                      </code>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
