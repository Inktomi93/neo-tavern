import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

const characterSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  description: z.string().min(1, "Description is required"),
  personality: z.string(),
  scenario: z.string(),
  firstMessage: z.string(),
  systemPromptOverride: z.string(),
});

type CharacterFormValues = z.infer<typeof characterSchema>;

export function CharacterEditor() {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarAssetId, setAvatarAssetId] = useState<string | null>(null);

  const createCharacter = trpc.character.create.useMutation({
    onSuccess: () => {
      toast.success("Character created successfully!");
    },
    onError: (err: { message: string }) => {
      toast.error(`Failed to create character: ${err.message}`);
    },
  });

  const form = useForm<CharacterFormValues>({
    resolver: zodResolver(characterSchema),
    defaultValues: {
      name: "",
      description: "",
      personality: "",
      scenario: "",
      firstMessage: "",
      systemPromptOverride: "",
    },
  });

  const onSubmit = (data: CharacterFormValues) => {
    createCharacter.mutate({
      ...data,
      handle: data.name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
      avatarAssetId,
    });
  };

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setAvatarUrl(URL.createObjectURL(file));

    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", "avatar");

    try {
      const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
      if (res.ok) {
        const data = await res.json();
        setAvatarAssetId(data.assetId);
      } else {
        toast.error("Failed to upload avatar");
      }
    } catch (_err) {
      toast.error("Error uploading avatar");
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="character-editor-container">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Character Editor</h1>
        <p className="text-muted-foreground">Create or modify a character's core identity.</p>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
        {/* Avatar */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="avatar">
            Avatar Image
          </label>
          <div className="flex items-center gap-4">
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt="Avatar Preview"
                className="h-16 w-16 rounded-full object-cover border"
              />
            )}
            <input
              id="avatar"
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="text-sm file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
            />
          </div>
        </div>

        {/* Name */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="character-name">
            Name
          </label>
          <input
            id="character-name"
            {...form.register("name")}
            className="flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="E.g., Seraphina"
          />
          {form.formState.errors.name && (
            <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
          )}
        </div>

        {/* Description */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="character-description">
            Description (Physical & Background)
          </label>
          <textarea
            id="character-description"
            {...form.register("description")}
            className="flex min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Appearance, history, and core traits..."
          />
          {form.formState.errors.description && (
            <p className="text-xs text-destructive">{form.formState.errors.description.message}</p>
          )}
        </div>

        {/* Personality */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="character-personality">
            Personality
          </label>
          <textarea
            id="character-personality"
            {...form.register("personality")}
            className="flex min-h-[80px] w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="How they speak and behave..."
          />
        </div>

        {/* Scenario */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="character-scenario">
            Scenario
          </label>
          <textarea
            id="character-scenario"
            {...form.register("scenario")}
            className="flex min-h-[80px] w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="The setting or immediate context of the chat..."
          />
        </div>

        {/* First Message */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="character-first-message">
            First Message
          </label>
          <textarea
            id="character-first-message"
            {...form.register("firstMessage")}
            className="flex min-h-[120px] w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="The greeting the user sees when starting a new chat..."
          />
        </div>

        <div className="flex justify-end pt-4 border-t">
          <Button
            type="submit"
            disabled={createCharacter.isPending}
            data-testid="save-character-btn"
          >
            {createCharacter.isPending ? "Saving..." : "Save Character"}
          </Button>
        </div>
      </form>
    </div>
  );
}
