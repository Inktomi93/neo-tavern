import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-3xl tracking-tight">neo-tavern</h1>
        <p className="text-muted-foreground text-sm">{status}</p>
      </header>
      <CreateChatForm onCreated={(id) => navigate({ to: "/chats/$id", params: { id } })} />
    </main>
  );
}
