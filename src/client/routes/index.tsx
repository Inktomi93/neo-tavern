import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CreateChatForm } from "../features/chat";
import { trpc } from "../lib/trpc";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const health = trpc.health.useQuery();

  let status = "contacting server…";
  if (health.isError) {
    status = "server unreachable";
  } else if (health.data) {
    status = `server ok — v${health.data.version}`;
  }

  return (
    <div
      className="mx-auto flex h-full max-w-2xl flex-col justify-center gap-8 p-8"
      data-testid="home-page-route"
    >
      <header className="flex flex-col gap-2 text-center">
        <h1 id="home-title" className="font-bold text-4xl tracking-tight text-primary">
          neo-tavern
        </h1>
        <p className="text-muted-foreground text-sm" role="status" aria-live="polite">
          {status}
        </p>
      </header>

      <div className="rounded-xl border bg-card p-6 shadow-sm" data-testid="create-chat-container">
        <CreateChatForm onCreated={(id) => navigate({ to: "/chats/$id", params: { id } })} />
      </div>

      <div className="flex justify-center mt-4">
        <Link
          to="/corpus"
          search={{ mode: "discover", q: "", rerank: false }}
          className="text-muted-foreground text-sm hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md px-4 py-2"
          data-testid="home-corpus-link"
        >
          Explore the Corpus →
        </Link>
      </div>
    </div>
  );
}
