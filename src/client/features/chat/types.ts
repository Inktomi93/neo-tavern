import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/trpc/router";

// The message shape, inferred from the router (type-only across the boundary — the
// sanctioned client↔server seam). No manual duplication of the server's MessageView.
type Outputs = inferRouterOutputs<AppRouter>;
export type ChatMessage = Outputs["chat"]["messages"][number];
