import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CharacterLibrary } from "../features/characters";
import { ChatList, CreateChatForm } from "../features/chat";

export type HomeSearch = {
  tab?: "chats" | "characters";
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    const s = search as { tab?: unknown };
    return {
      tab: s.tab === "characters" ? "characters" : "chats",
    };
  },
  component: HomePage,
});

function HomePage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  return (
    <Tabs
      value={search.tab || "chats"}
      onValueChange={(val) => navigate({ to: "/", search: { tab: val as "chats" | "characters" } })}
      className="mx-auto flex h-full w-full max-w-[1600px] flex-col p-4 sm:p-8 relative z-10"
      data-testid="home-page-route"
    >
      <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1
            id="home-title"
            className="font-bold text-3xl tracking-tight text-foreground bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent"
          >
            NeoTavern
          </h1>
          <p className="text-muted-foreground text-sm mt-1 font-medium">
            Welcome to your personal roleplay sandbox.
          </p>
        </div>

        {/* Tab Switcher */}
        <TabsList className="w-full md:w-[350px] bg-card/60 backdrop-blur-xl border border-border/50 h-11">
          <TabsTrigger value="chats" className="flex-1 text-sm">
            Recent Chats
          </TabsTrigger>
          <TabsTrigger value="characters" className="flex-1 text-sm">
            Character Library
          </TabsTrigger>
        </TabsList>
      </header>

      <div className="flex-1 overflow-y-auto pb-12">
        <TabsContent
          value="chats"
          className="h-full m-0 data-[state=active]:flex flex-col outline-none"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[1fr_1.5fr] min-h-[500px] w-full rounded-2xl border bg-card/40 shadow-sm backdrop-blur-xl overflow-hidden">
            <div className="p-6 overflow-hidden flex flex-col border-b md:border-b-0 md:border-r border-border/50">
              <h2 className="font-semibold text-lg mb-6 tracking-tight shrink-0">
                Start Anonymous Chat
              </h2>
              <div className="flex-1 overflow-y-auto pr-2">
                <CreateChatForm
                  onCreated={(id) => navigate({ to: "/chats/$id", params: { id } })}
                />
              </div>
            </div>

            <div className="p-6 bg-muted/20 overflow-hidden flex flex-col">
              <h2 className="font-semibold text-lg mb-6 tracking-tight shrink-0">
                Active Sessions
              </h2>
              <div className="flex-1 overflow-hidden">
                <ChatList />
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent
          value="characters"
          className="h-full m-0 data-[state=active]:flex flex-col outline-none"
        >
          <CharacterLibrary />
        </TabsContent>
      </div>
    </Tabs>
  );
}
