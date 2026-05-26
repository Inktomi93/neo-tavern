import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { sessionEntries } from "../../../db/schema";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";

// The main transcript has no SessionKey.subpath. We store "" (NOT null) for it so the
// (session_id, subpath, uuid) unique index actually dedups replayed uuids: SQLite treats
// every NULL as DISTINCT, so a null subpath would defeat the uuid idempotency the SDK
// relies on (it replays uuids on retry / importSessionToStore). "" is internal-only — it
// is never handed back to the SDK as a SessionKey.subpath (where empty string is invalid).
const MAIN_TRANSCRIPT_SUBPATH = "";

// The DB-backed SessionStore: the SDK's resume substrate, persisted to our
// `session_entries` table instead of disk (validated in CACHE=1 sdk:play). The raw
// SDK transcript, opaque — SEPARATE from `messages` (our clean canon). Constructed
// per-chat so the rows carry our chatId; the SDK keys by SessionKey (sessionId +
// optional subpath for subagents).
export class DbSessionStore implements SessionStore {
  private readonly db: Db;
  private readonly chatId: string;

  constructor(db: Db, chatId: string) {
    this.db = db;
    this.chatId = chatId;
  }

  private subpathFilter(subpath: string | undefined) {
    return eq(sessionEntries.subpath, subpath ?? MAIN_TRANSCRIPT_SUBPATH);
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const subpath = key.subpath ?? MAIN_TRANSCRIPT_SUBPATH;
    const last = await this.db
      .select({ seq: sessionEntries.seq })
      .from(sessionEntries)
      .where(and(eq(sessionEntries.sessionId, key.sessionId), this.subpathFilter(key.subpath)))
      .orderBy(desc(sessionEntries.seq))
      .limit(1);

    let seq = (last[0]?.seq ?? -1) + 1;
    const now = Date.now();
    const rows = entries.map((entry) => ({
      id: newId(),
      chatId: this.chatId,
      sessionId: key.sessionId,
      subpath,
      seq: seq++,
      uuid: typeof entry.uuid === "string" ? entry.uuid : null,
      type: entry.type,
      entry,
      createdAt: now,
    }));

    // Upsert semantics: frames with a uuid dedup on the (session_id, subpath, uuid)
    // partial unique index (SDK replays uuids on retry / import); frames without a
    // uuid (titles, mode markers) always insert. onConflictDoNothing covers both.
    await this.db.insert(sessionEntries).values(rows).onConflictDoNothing();

    // Per-op trace of the resume substrate growing — metadata only (frame types/counts, never
    // content). Makes session growth + compaction curl-able at LOG_LEVEL=debug.
    getLog().debug(
      {
        chatId: this.chatId,
        sessionId: key.sessionId,
        added: rows.length,
        types: rows.map((r) => r.type),
      },
      "session store: appended frames",
    );
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = await this.db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(and(eq(sessionEntries.sessionId, key.sessionId), this.subpathFilter(key.subpath)))
      .orderBy(asc(sessionEntries.seq));

    getLog().debug(
      { chatId: this.chatId, sessionId: key.sessionId, frames: rows.length },
      "session store: loaded frames for resume",
    );
    if (rows.length === 0) {
      return null; // "never written" — the SDK starts a fresh session
    }
    return rows.map((row) => row.entry as SessionStoreEntry);
  }

  // We don't use subagent transcripts in chat; the SDK probes this during resume.
  listSubkeys(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
