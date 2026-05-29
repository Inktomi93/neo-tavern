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
