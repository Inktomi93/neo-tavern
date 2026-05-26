import { randomUUID } from "node:crypto";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_CHAT_MODEL_ID } from "../../../shared/models";

// Synthesize Agent SDK SessionStore frames from plain canon (role + text) so a FRESH session
// resumes coherently — for raw→sdk fork and ST-import continuation, where we have the transcript
// but none of the SDK's runtime bookkeeping (promptId/requestId/cwd/timestamps).
//
// The shape is EMPIRICALLY VALIDATED — `scripts/seed-probe.ts`, run live against the sub:
//   • bare frames (type/uuid/parentUuid/message) → SDK rejects: "No conversation found"
//   • + per-frame metadata (sessionId/isSidechain/cwd/version/userType + promptId/requestId/
//     timestamp) → RESUMES + recalls a seeded fact ✓  ← the load-bearing piece
//   • the `last-prompt` bookmark, the `thinking` frame, `ai-title`, `queue-operation`, and the
//     dual-assistant-frame structure the SDK normally writes are all UNNECESSARY for resume.
//   • an ASSISTANT-FIRST seed (a greeting with no preceding user turn) does NOT work — the model
//     won't own a message it has no memory of generating. So greetings are handled as canon
//     (raw-mode) / display, NOT by seeding an assistant-only sdk session.
// cwd/version are arbitrary-but-present (part of the proven bundle); if the Agent SDK is upgraded,
// re-run the probe to confirm the shape still resumes.

export interface SeedTurn {
  role: "user" | "assistant";
  content: string;
  /** The model that produced an assistant turn (provenance); falls back to the sdk default. */
  model?: string | null;
}

/**
 * The ST "invisible user" trick. A greeting is an assistant opening with NO preceding user turn,
 * but a session must start user-first to resume cleanly, so we prefix this SESSION-ONLY stub →
 * the validated user→assistant shape. It is NEVER written to `messages` (the UI never shows it);
 * it only frames the greeting so the model owns it on resume. Validated (seed-probe, Haiku +
 * Sonnet): with the character system prompt the model continues in-character from the greeting.
 */
export const GREETING_USER_STUB = "*The scene begins.*";

const SEED_VERSION = "2.0.0";
const SEED_CWD = "/";

/**
 * Build the SDK session frames for `canon` under `sessionId` (which MUST be a valid uuidv4 — the
 * SDK rejects arbitrary resume ids). Frames chain via `parentUuid`; every frame carries the
 * sessionId. Caller persists them (DbSessionStore.append) and sets `chats.sessionId = sessionId`.
 */
export function buildSeedFrames(canon: SeedTurn[], sessionId: string): SessionStoreEntry[] {
  const common = {
    isSidechain: false,
    cwd: SEED_CWD,
    version: SEED_VERSION,
    sessionId,
    userType: "external",
  };
  const frames: SessionStoreEntry[] = [];
  let parentUuid: string | null = null;

  canon.forEach((m, i) => {
    const uuid = randomUUID();
    const timestamp = new Date().toISOString();
    if (m.role === "user") {
      frames.push({
        type: "user",
        uuid,
        parentUuid,
        promptId: randomUUID(),
        timestamp,
        ...common,
        message: { role: "user", content: [{ type: "text", text: m.content }] },
      } as unknown as SessionStoreEntry);
    } else {
      frames.push({
        type: "assistant",
        uuid,
        parentUuid,
        requestId: `req_seed_${i}`,
        timestamp,
        ...common,
        message: {
          role: "assistant",
          model: m.model ?? DEFAULT_CHAT_MODEL_ID,
          id: `msg_seed_${i}`,
          type: "message",
          content: [{ type: "text", text: m.content }],
          stop_reason: "end_turn",
        },
      } as unknown as SessionStoreEntry);
    }
    parentUuid = uuid;
  });

  return frames;
}
