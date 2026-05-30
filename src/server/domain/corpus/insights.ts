import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";

// Behavioral insights over the message/chat history — all pure SQL, all relational (every row carries
// the entity id + the score). Forgotten gems (revisit candidates), model routing (which model you reach
// for per genre), and theme drift (how your RP shifts over story time).

export interface ForgottenGem {
  characterId: string;
  name: string;
  messages: number; // engagement you invested
  tokensOut: number;
  lastActive: number | null; // epoch-ms UTC — how long since you touched it
}

/** Characters you invested in (real message volume) but haven't touched recently — worth revisiting. */
export async function forgottenGems(db: Db, ownerId: string, limit = 20): Promise<ForgottenGem[]> {
  return db.all<ForgottenGem>(sql`
    SELECT cv.character_id AS characterId, MIN(cv.name) AS name,
           COUNT(m.id) AS messages, COALESCE(SUM(m.tokens_out), 0) AS tokensOut,
           MAX(m.created_at) AS lastActive
    FROM chats ch
    JOIN character_versions cv ON cv.id = ch.character_version_id
    LEFT JOIN messages m ON m.chat_id = ch.id
    WHERE ch.owner_id = ${ownerId}
    GROUP BY cv.character_id
    HAVING COUNT(m.id) >= 30
    ORDER BY lastActive ASC
    LIMIT ${limit}
  `);
}

export interface ModelRouting {
  genre: string;
  models: { model: string; messages: number; share: number }[];
}

/** Which model you actually reach for per genre (kept assistant messages × distilled genre). */
export async function modelRouting(db: Db, ownerId: string): Promise<ModelRouting[]> {
  const rows = await db.all<{ genre: string; model: string; messages: number }>(sql`
    SELECT cs.genre AS genre, m.model AS model, COUNT(*) AS messages
    FROM messages m
    JOIN chats ch ON ch.id = m.chat_id
    JOIN character_versions cv ON cv.id = ch.character_version_id
    JOIN character_summaries cs ON cs.character_id = cv.character_id
    WHERE ch.owner_id = ${ownerId} AND m.role = 'assistant'
      AND m.model IS NOT NULL AND cs.genre IS NOT NULL
    GROUP BY cs.genre, m.model
  `);
  const byGenre = new Map<string, { model: string; messages: number }[]>();
  for (const r of rows) {
    const list = byGenre.get(r.genre) ?? [];
    list.push({ model: r.model, messages: r.messages });
    byGenre.set(r.genre, list);
  }
  const out: ModelRouting[] = [];
  for (const [genre, models] of byGenre) {
    const total = models.reduce((s, x) => s + x.messages, 0);
    out.push({
      genre,
      models: models
        .map((x) => ({ ...x, share: total > 0 ? x.messages / total : 0 }))
        .sort((a, b) => b.messages - a.messages)
        .slice(0, 5),
    });
  }
  return out.sort((a, b) => {
    const am = a.models.reduce((s, x) => s + x.messages, 0);
    const bm = b.models.reduce((s, x) => s + x.messages, 0);
    return bm - am;
  });
}

export interface ThemeDriftBucket {
  bucket: string; // YYYY-MM (story time)
  themes: { clusterIdx: number; themeName: string; count: number }[];
}

/** How your themes shift over STORY time — per-month theme prevalence (drift). */
export async function themeDrift(
  db: Db,
  ownerId: string,
  level: "scene" | "arc" = "arc",
): Promise<ThemeDriftBucket[]> {
  const rows = await db.all<{
    bucket: string;
    clusterIdx: number;
    themeName: string;
    count: number;
  }>(sql`
    SELECT strftime('%Y-%m', cd.msg_mid_at / 1000, 'unixepoch') AS bucket,
           dta.cluster_idx AS clusterIdx, tc.theme_name AS themeName, COUNT(*) AS count
    FROM digest_theme_assignments dta
    JOIN chat_digests cd ON cd.id = dta.digest_id
    JOIN theme_clusters tc ON tc.owner_id = dta.owner_id AND tc.level = dta.level
      AND tc.cluster_idx = dta.cluster_idx
    WHERE dta.owner_id = ${ownerId} AND dta.level = ${level} AND cd.msg_mid_at IS NOT NULL
    GROUP BY bucket, dta.cluster_idx
    ORDER BY bucket ASC, count DESC
  `);
  const byBucket = new Map<string, { clusterIdx: number; themeName: string; count: number }[]>();
  for (const r of rows) {
    const list = byBucket.get(r.bucket) ?? [];
    list.push({ clusterIdx: r.clusterIdx, themeName: r.themeName, count: r.count });
    byBucket.set(r.bucket, list);
  }
  return [...byBucket.entries()].map(([bucket, themes]) => ({
    bucket,
    themes: themes.slice(0, 6),
  }));
}
