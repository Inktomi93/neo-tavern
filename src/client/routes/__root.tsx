import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100 antialiased">
      <Outlet />
    </div>
  );
}
