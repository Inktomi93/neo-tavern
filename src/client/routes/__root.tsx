import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Library, MessageSquare } from "lucide-react";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createRootRoute({
  component: RootLayout,
});

function NavRail() {
  const location = useLocation();

  const links = [
    { to: "/", icon: MessageSquare, label: "Chat", testId: "nav-chat" },
    {
      to: "/corpus",
      search: { mode: "discover", q: "", rerank: false },
      icon: Library,
      label: "Corpus",
      testId: "nav-corpus",
    },
  ];

  return (
    <nav
      className="flex flex-row items-center justify-around border-t bg-background p-2 sm:w-16 sm:flex-col sm:justify-start sm:gap-4 sm:border-r sm:border-t-0 sm:p-4 z-50 shrink-0"
      data-testid="app-nav-rail"
      aria-label="Main Navigation"
    >
      {/* Mobile-first bottom bar, Desktop left rail */}
      {links.map((item) => {
        const Icon = item.icon;
        const isActive =
          location.pathname === item.to ||
          (item.to !== "/" && location.pathname.startsWith(item.to));

        return (
          <Link
            key={item.label}
            to={item.to as string}
            search={item.search as Record<string, unknown>}
            data-testid={item.testId}
            aria-label={item.label}
            className={cn(
              "flex flex-col items-center justify-center rounded-xl p-2 sm:p-3 transition-colors hover:bg-muted group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          >
            <Icon
              className="size-6 sm:size-5 transition-transform group-hover:scale-110"
              aria-hidden="true"
            />
            <span className="mt-1 text-[10px] font-medium sm:sr-only">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function RootLayout() {
  return (
    <div className="flex h-dvh w-full flex-col-reverse sm:flex-row bg-background text-foreground antialiased selection:bg-primary/20">
      <NavRail />
      <main className="flex-1 overflow-hidden relative" data-testid="app-main-content">
        <Outlet />
      </main>
      <Toaster position="bottom-right" theme="dark" richColors />
    </div>
  );
}
