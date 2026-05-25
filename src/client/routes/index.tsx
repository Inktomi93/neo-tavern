import { createFileRoute } from "@tanstack/react-router";
import { trpc } from "../lib/trpc";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const health = trpc.health.useQuery();

  let status = "contacting server…";
  if (health.isError) {
    status = "server unreachable";
  } else if (health.data) {
    status = `server ok — v${health.data.version}`;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-3 p-8">
      <h1 className="font-semibold text-3xl tracking-tight">neo-tavern</h1>
      <p className="text-sm text-zinc-400">{status}</p>
    </main>
  );
}
