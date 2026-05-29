// The resolved caller identity — a pure shape (no logic), in `shared` so BOTH the auth seam
// (server/auth, which produces it) and the tRPC context (server/trpc, which carries it) can name it
// without the trpc→auth import the layer cake forbids. `externalId` is the stable authentik sub/uid
// (null for the single-user / owner-fallback path, which keys on `handle`); `groups` drives admin
// determination. See docs/auth-and-credentials-plan.md §2/§6.
export interface ResolvedIdentity {
  externalId: string | null;
  handle: string;
  groups: string[];
}
