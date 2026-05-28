import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCreateChat } from "../hooks/use-chat";

const createChatSchema = z.object({
  title: z.string().min(1, "Title is required").max(100),
  characterName: z.string().min(1, "Character name is required").max(100),
  characterDescription: z.string().max(1000).optional(),
});

type FormValues = z.infer<typeof createChatSchema>;

export function CreateChatForm({ onCreated }: { onCreated: (chatId: string) => void }) {
  const create = useCreateChat();
  const form = useForm<FormValues>({
    resolver: zodResolver(createChatSchema),
    defaultValues: {
      title: "",
      characterName: "",
      characterDescription: "",
    },
  });

  function onSubmit(values: FormValues) {
    if (create.isPending) return;
    create.mutate(
      {
        title: values.title,
        characterName: values.characterName,
        characterDescription: values.characterDescription || "",
      },
      { onSuccess: (result) => onCreated(result.chatId) },
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Chat Title</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Tavern Encounter"
                  {...field}
                  className="bg-background/50"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="characterName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Character Name</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Professor Mari" {...field} className="bg-background/50" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="characterDescription"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Character Description</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="Optional background or scenario details..."
                  {...field}
                  className="bg-background/50 resize-none"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={create.isPending} className="self-start mt-2 shadow-sm">
          {create.isPending ? "Creating…" : "Start Roleplay"}
        </Button>
      </form>
    </Form>
  );
}
