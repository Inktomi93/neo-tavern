import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../../../../db/client";
import { type chats, sessionEntries } from "../../../../db/schema";
import { buildSeedFrames, GREETING_USER_STUB, type SeedTurn } from "../seed";
import { DbSessionStore } from "../store";
import { loadCanonHistory } from "./queries";

export async function seedSessionFromCanon(db: Db, chatId: string): Promise<string> {
  const canon = await loadCanonHistory(db, chatId);
  const newSessionId = randomUUID();
  if (canon.length > 0) {
    const seed: SeedTurn[] =
      canon[0]?.role === "assistant"
        ? [{ role: "user", content: GREETING_USER_STUB }, ...canon]
        : canon;
    await new DbSessionStore(db, chatId).append(
      { projectKey: chatId, sessionId: newSessionId },
      buildSeedFrames(seed, newSessionId),
    );
  }
  return newSessionId;
}

export async function reseedSdkSession(
  db: Db,
  chat: typeof chats.$inferSelect,
): Promise<string | null> {
  if (chat.api !== "agent-sdk") {
    return null;
  }
  if (chat.sessionId !== null) {
    await db.delete(sessionEntries).where(eq(sessionEntries.sessionId, chat.sessionId));
  }
  return seedSessionFromCanon(db, chat.id);
}
