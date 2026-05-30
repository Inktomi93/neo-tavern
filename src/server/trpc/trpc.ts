// The tRPC init lives here (not in router.ts) so sub-routers can import `t` without
// a cycle through the root router.
import { initTRPC, TRPCError } from "@trpc/server";
import {
  DomainConflictError,
  DomainForbiddenError,
  DomainNotFoundError,
  DomainOperationError,
} from "../domain/_shared/errors";
import type { Context } from "./context";

export const t = initTRPC.context<Context>().create();

const domainErrorMiddleware = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause ?? result.error;
    if (cause instanceof DomainNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: cause.message, cause });
    }
    if (cause instanceof DomainConflictError) {
      throw new TRPCError({ code: "CONFLICT", message: cause.message, cause });
    }
    if (cause instanceof DomainForbiddenError) {
      throw new TRPCError({ code: "FORBIDDEN", message: cause.message, cause });
    }
    if (cause instanceof DomainOperationError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: cause.message, cause });
    }
  }
  return result;
});

export const publicProcedure = t.procedure.use(domainErrorMiddleware);

// ── The procedure ladder (docs/auth/auth-and-credentials-plan.md §3) ──────────────────────────────────
// publicProcedure → authedProcedure (+ the CSRF mutation gate) → adminProcedure. Built ONCE here;
// every router picks the right rung. The gates read the resolved `ctx.auth` (produced at the seam) —
// trpc never touches db/auth itself (the layer cake).

// authedProcedure: a resolved identity is required (null only under AUTH_FALLBACK=deny with no
// credential → 401). PLUS the CSRF mitigation: a COOKIE-authenticated MUTATION must carry the custom
// header (SameSite=Lax + this header is the whole story, §4). The gate is per-request, keyed on
// `viaCookie` — a header/fallback request (no cross-site surface) and all queries/subscriptions are
// exempt, so the zero-infra default and the SSE stream are untouched.
const authMiddleware = t.middleware(({ ctx, type, next }) => {
  if (ctx.auth.identity === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required." });
  }
  if (type === "mutation" && ctx.auth.viaCookie && !ctx.auth.hasCsrfHeader) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Missing CSRF header." });
  }
  return next();
});
export const authedProcedure = publicProcedure.use(authMiddleware);

// adminProcedure: authed + admin role. The role is resolved at the seam (provisionIdentity for SSO;
// owner for the fallback), so the gate is a plain field check — no db round-trip in the transport.
const adminMiddleware = t.middleware(({ ctx, next }) => {
  if (ctx.auth.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "This action requires an admin user." });
  }
  return next();
});
export const adminProcedure = authedProcedure.use(adminMiddleware);
