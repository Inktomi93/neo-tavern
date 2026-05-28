import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Home, Library } from "lucide-react";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const Route = createRootRoute({
  component: RootLayout,
});

function NavRail() {
  const location = useLocation();

  const links = [
    { to: "/", icon: Home, label: "Home", testId: "nav-chat" },
    {
      to: "/corpus",
      search: { mode: "chats", q: "", rerank: false },
      icon: Library,
      label: "Lorebook",
      testId: "nav-corpus",
    },
  ];

  return (
    <nav
      className="flex flex-row items-center justify-around border-t border-border/50 bg-background/80 backdrop-blur-xl p-2 sm:w-16 sm:flex-col sm:justify-start sm:gap-4 sm:border-r sm:border-t-0 sm:p-4 z-50 shrink-0 relative"
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
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh w-full flex-col-reverse sm:flex-row bg-background text-foreground antialiased selection:bg-primary/20 relative overflow-hidden">
        {/* Decorative Background */}
        <div className="absolute inset-0 z-0 pointer-events-none">
          <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] bg-primary/10 rounded-full blur-[120px] mix-blend-screen" />
          <div className="absolute bottom-[10%] -right-[10%] w-[40%] h-[60%] bg-indigo-500/10 rounded-full blur-[140px] mix-blend-screen" />
          <div className="absolute top-[40%] left-[60%] w-[30%] h-[30%] bg-purple-500/10 rounded-full blur-[100px] mix-blend-screen" />
        </div>

        <NavRail />
        <main className="flex-1 overflow-hidden relative z-10" data-testid="app-main-content">
          <Outlet />
        </main>
        <Toaster position="bottom-right" theme="dark" richColors />
      </div>
    </TooltipProvider>
  );
}
