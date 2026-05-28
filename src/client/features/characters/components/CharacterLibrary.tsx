import { MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";

export function CharacterLibrary() {
  const { data: characters, isLoading } = trpc.character.list.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading characters...</div>
      </div>
    );
  }

  const selected = characters?.find((c) => c.id === selectedId) || characters?.[0];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_350px] xl:grid-cols-[1fr_400px] h-full w-full rounded-2xl border bg-card/40 shadow-sm backdrop-blur-xl overflow-hidden">
      {/* Left Grid */}
      <div className="flex flex-col gap-6 p-6 min-h-[500px]">
        <ScrollArea className="h-full w-full pr-4">
          <div className="flex justify-between items-center sticky top-0 bg-background/80 backdrop-blur-md z-10 -mx-2 px-2 py-2 mb-6 rounded-b-xl">
            <h2 className="text-xl font-semibold">Your Characters</h2>
            <Button
              size="sm"
              variant="outline"
              className="gap-2 shadow-sm bg-background/50 backdrop-blur-sm"
            >
              <Plus className="size-4" /> New Character
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 px-4 pb-12 pt-4">
            {characters?.map((char) => (
              <button
                type="button"
                key={char.id}
                onClick={() => setSelectedId(char.id)}
                className={`flex flex-col items-center gap-4 rounded-2xl border border-border/40 bg-card/40 p-5 text-center transition-all duration-300 hover:bg-card/60 hover:shadow-xl hover:-translate-y-1 backdrop-blur-md group ${
                  selected?.id === char.id ? "ring-2 ring-primary bg-card/60" : ""
                }`}
              >
                <Avatar className="size-20 border border-border/50 shadow-inner group-hover:scale-105 transition-transform">
                  <AvatarImage
                    className="object-cover"
                    src={char.avatarHash ? `/api/blob/${char.avatarHash}` : undefined}
                  />
                  <AvatarFallback className="text-2xl font-bold bg-muted/80">
                    {(char.name || "U").charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="font-medium truncate w-full">{char.name || "Unknown"}</div>
              </button>
            ))}
            {characters?.length === 0 && (
              <div className="col-span-full py-16 text-center text-muted-foreground border border-dashed rounded-xl bg-muted/20">
                No characters found. Create your first!
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right Detail Pane */}
      {selected && (
        <div className="flex flex-col gap-6 p-6 bg-muted/20 border-t lg:border-t-0 lg:border-l border-border/50">
          <ScrollArea className="h-full w-full pr-4">
            <div className="flex flex-col items-center gap-4 text-center">
              <Avatar className="size-36 border border-border/50 shadow-xl">
                <AvatarImage
                  className="object-cover"
                  src={selected.avatarHash ? `/api/blob/${selected.avatarHash}` : undefined}
                />
                <AvatarFallback className="text-5xl font-bold bg-muted/80">
                  {(selected.name || "U").charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <h3 className="text-2xl font-bold tracking-tight">{selected.name || "Unknown"}</h3>
                <p className="text-xs font-medium text-muted-foreground mt-1.5 uppercase tracking-wider">
                  Created {new Date(selected.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>

            <Button className="w-full gap-2 shadow-lg hover:shadow-primary/25 transition-all py-6 rounded-xl font-semibold">
              <MessageSquare className="size-5" /> Start Chat
            </Button>

            <div className="text-sm mt-8">
              <h4 className="font-semibold text-muted-foreground uppercase tracking-wider text-[10px] mb-3">
                Description
              </h4>
              <p className="text-foreground/90 leading-relaxed text-sm">
                {selected.description || "No description provided."}
              </p>
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
