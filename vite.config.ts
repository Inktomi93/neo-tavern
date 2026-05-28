import process from "node:process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // `@/…` → src/client (mirrors tsconfig paths; shadcn convention).
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/client", import.meta.url)) },
  },
  plugins: [
    // Must precede react() so the route tree is generated from untransformed source.
    tanstackRouter({
      target: "react",
      routesDirectory: "src/client/routes",
      generatedRouteTree: "src/client/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    watch: {
      ignored: ["**/references/**"],
    },
    proxy: {
      // Vite is the dev front door; Hono owns /api here and serves the built
      // bundle itself in production.
      "/api": {
        target: `http://127.0.0.1:${process.env["PORT"] ?? 8788}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
});
