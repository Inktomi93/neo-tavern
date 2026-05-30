import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";

// Swipe / re-roll analytics over `message_variants` — a signal nobody else mines. A message's variant
// count = how many times you re-rolled it: high counts mark where the model STRUGGLED or you were
// picky. Pure SQL, owner-scoped via chats. (Re-roll = the user wasn't satisfied with the first take.)

export interface SwipeInsights {
  totalSwipes: number;
  messagesWithSwipes: number;
  avgSwipesPerRerolledMessage: number;
  /** The most re-rolled moments — where the model kept missing (or you kept refining). */
  hotspots: {
    chatId: string;
    characterName: string;
    variants: number;
    snippet: string;
  }[];
  /** Per character: how hard the model makes you work. High avgSwipes = a card the model fumbles. */
  byCharacter: {
    characterId: string;
    name: string;
    rerolledMessages: number;
    swipes: number;
    avgSwipes: number;
  }[];
  /** Which models you lean on inside re-roll pools (the models you reach for when the first take fails). */
  byModel: { model: string; poolCount: number }[];
}

export async function swipeInsights(db: Db, ownerId: string): Promise<SwipeInsights> {
  const totals = (
    await db.all<{ swipes: number; msgs: number }>(sql`
      SELECT COUNT(mv.id) AS swipes, COUNT(DISTINCT mv.message_id) AS msgs
      FROM message_variants mv
      JOIN messages m ON m.id = mv.message_id
      JOIN chats ch ON ch.id = m.chat_id
      WHERE ch.owner_id = ${ownerId}
    `)
  )[0] ?? { swipes: 0, msgs: 0 };

  const hotspots = await db.all<{
    chatId: string;
    characterName: string;
    variants: number;
    snippet: string;
  }>(sql`
    SELECT m.chat_id AS chatId, cv.name AS characterName, COUNT(mv.id) AS variants,
           substr(m.content, 1, 140) AS snippet
    FROM message_variants mv
    JOIN messages m ON m.id = mv.message_id
    JOIN chats ch ON ch.id = m.chat_id
    JOIN character_versions cv ON cv.id = ch.character_version_id
    WHERE ch.owner_id = ${ownerId} AND m.role = 'assistant'
    GROUP BY m.id ORDER BY variants DESC LIMIT 15
  `);

  const byCharacter = await db.all<{
    characterId: string;
    name: string;
    rerolledMessages: number;
    swipes: number;
    avgSwipes: number;
  }>(sql`
    SELECT cv.character_id AS characterId, MIN(cv.name) AS name,
           COUNT(DISTINCT m.id) AS rerolledMessages, COUNT(mv.id) AS swipes,
           CAST(COUNT(mv.id) AS REAL) / COUNT(DISTINCT m.id) AS avgSwipes
    FROM message_variants mv
    JOIN messages m ON m.id = mv.message_id
    JOIN chats ch ON ch.id = m.chat_id
    JOIN character_versions cv ON cv.id = ch.character_version_id
    WHERE ch.owner_id = ${ownerId} AND m.role = 'assistant'
    GROUP BY cv.character_id
    HAVING COUNT(DISTINCT m.id) >= 5
    ORDER BY avgSwipes DESC LIMIT 20
  `);

  const byModel = await db.all<{ model: string; poolCount: number }>(sql`
    SELECT COALESCE(mv.model, '(unknown)') AS model, COUNT(*) AS poolCount
    FROM message_variants mv
    JOIN messages m ON m.id = mv.message_id
    JOIN chats ch ON ch.id = m.chat_id
    WHERE ch.owner_id = ${ownerId}
    GROUP BY mv.model ORDER BY poolCount DESC LIMIT 20
  `);

  return {
    totalSwipes: totals.swipes,
    messagesWithSwipes: totals.msgs,
    avgSwipesPerRerolledMessage: totals.msgs > 0 ? totals.swipes / totals.msgs : 0,
    hotspots,
    byCharacter,
    byModel,
  };
}
