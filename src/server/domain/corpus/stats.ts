import { sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { collapseByContentHash } from "../../../shared/content-hash";

// Raw `sql` returns a json `text` column as a STRING (it bypasses drizzle's json codec), so parse it
// here. Lenient: a malformed/empty value yields no keywords rather than throwing.
function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Corpus dashboard + per-character profile — pure SQL aggregates over the owner's rows (no GPU, no
// vectors). docs/planning/breadth-buildout.md B.6. Time is epoch-ms UTC (shared/time.ts invariant);
// day/hour buckets use sqlite strftime on `created_at/1000` so the client gets ready-to-plot series.

export interface CorpusStats {
  totals: {
    characters: number;
    chats: number;
    messages: number;
    digests: number;
    segments: number;
  };
  byModel: { model: string; messages: number }[];
  topCharacters: { characterId: string; name: string; chats: number; messages: number }[];
  tags: { name: string; count: number }[];
  timeline: { day: string; messages: number }[]; // per-day message counts (UTC)
  byHour: { hour: number; messages: number }[]; // 24-bucket hour-of-day histogram (UTC)
}

export async function corpusStats(db: Db, ownerId: string): Promise<CorpusStats> {
  const totalsRow = await db.all<{
    characters: number;
    chats: number;
    messages: number;
    digests: number;
    segments: number;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM characters WHERE owner_id = ${ownerId}) AS characters,
      (SELECT COUNT(*) FROM chats WHERE owner_id = ${ownerId}) AS chats,
      (SELECT COUNT(*) FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE c.owner_id = ${ownerId}) AS messages,
      (SELECT COUNT(*) FROM chat_digests WHERE owner_id = ${ownerId}) AS digests,
      (SELECT COUNT(*) FROM chat_segments WHERE owner_id = ${ownerId}) AS segments
  `);

  const byModel = await db.all<{ model: string; messages: number }>(sql`
    SELECT COALESCE(m.model, '(unknown)') AS model, COUNT(*) AS messages
    FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE c.owner_id = ${ownerId} AND m.role = 'assistant'
    GROUP BY m.model ORDER BY messages DESC
  `);

  // Most-RP'd characters — grouped across a character's versions (the Hikari/Selene view).
  const topCharacters = await db.all<{
    characterId: string;
    name: string;
    chats: number;
    messages: number;
  }>(sql`
    SELECT cv.character_id AS characterId, MIN(cv.name) AS name,
           COUNT(DISTINCT ch.id) AS chats, COUNT(m.id) AS messages
    FROM chats ch
    JOIN character_versions cv ON cv.id = ch.character_version_id
    LEFT JOIN messages m ON m.chat_id = ch.id
    WHERE ch.owner_id = ${ownerId}
    GROUP BY cv.character_id
    ORDER BY chats DESC, messages DESC
    LIMIT 20
  `);

  const tags = await db.all<{ name: string; count: number }>(sql`
    SELECT t.name AS name, COUNT(*) AS count
    FROM character_tags ct JOIN tags t ON t.id = ct.tag_id
    JOIN characters c ON c.id = ct.character_id
    WHERE c.owner_id = ${ownerId}
    GROUP BY t.id ORDER BY count DESC LIMIT 30
  `);

  const timeline = await db.all<{ day: string; messages: number }>(sql`
    SELECT strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch') AS day, COUNT(*) AS messages
    FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE c.owner_id = ${ownerId}
    GROUP BY day ORDER BY day
  `);

  const byHour = await db.all<{ hour: number; messages: number }>(sql`
    SELECT CAST(strftime('%H', m.created_at / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS messages
    FROM messages m JOIN chats c ON c.id = m.chat_id
    WHERE c.owner_id = ${ownerId}
    GROUP BY hour ORDER BY hour
  `);

  const t = totalsRow[0] ?? { characters: 0, chats: 0, messages: 0, digests: 0, segments: 0 };
  return { totals: t, byModel, topCharacters, tags, timeline, byHour };
}

export interface CharacterProfile {
  characterId: string;
  name: string;
  refineryScore: number | null;
  chats: number;
  messages: number;
  userMessages: number;
  charMessages: number;
  tokensOut: number;
  firstAt: number | null; // epoch-ms UTC
  lastAt: number | null;
  digests: number;
  models: string[];
  topKeywords: { keyword: string; count: number }[];
}

export async function characterProfile(
  db: Db,
  ownerId: string,
  characterId: string,
): Promise<CharacterProfile | null> {
  const head = await db.all<{ name: string; refineryScore: number | null }>(sql`
    SELECT cv.name AS name, cv.refinery_score AS refineryScore
    FROM characters c JOIN character_versions cv ON cv.id = c.current_version_id
    WHERE c.id = ${characterId} AND c.owner_id = ${ownerId}
    LIMIT 1
  `);
  const h = head[0];
  if (!h) return null;

  const agg = await db.all<{
    chats: number;
    messages: number;
    userMessages: number;
    charMessages: number;
    tokensOut: number;
    firstAt: number | null;
    lastAt: number | null;
  }>(sql`
    SELECT COUNT(DISTINCT ch.id) AS chats,
           COUNT(m.id) AS messages,
           COALESCE(SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END), 0) AS userMessages,
           COALESCE(SUM(CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END), 0) AS charMessages,
           COALESCE(SUM(m.tokens_out), 0) AS tokensOut,
           MIN(m.created_at) AS firstAt, MAX(m.created_at) AS lastAt
    FROM chats ch
    JOIN character_versions cv ON cv.id = ch.character_version_id
    LEFT JOIN messages m ON m.chat_id = ch.id
    WHERE cv.character_id = ${characterId} AND ch.owner_id = ${ownerId}
  `);
  const a = agg[0] ?? {
    chats: 0,
    messages: 0,
    userMessages: 0,
    charMessages: 0,
    tokensOut: 0,
    firstAt: null,
    lastAt: null,
  };

  const models = (
    await db.all<{ model: string }>(sql`
      SELECT DISTINCT m.model AS model
      FROM messages m
      JOIN chats ch ON ch.id = m.chat_id
      JOIN character_versions cv ON cv.id = ch.character_version_id
      WHERE cv.character_id = ${characterId} AND ch.owner_id = ${ownerId}
        AND m.role = 'assistant' AND m.model IS NOT NULL
    `)
  ).map((r) => r.model);

  // Top keywords from this character's TIER-0 digests ONLY. Digest tiers are hierarchical — a tier-1+
  // consolidation re-summarizes its `fanOut` tier-0 children over the SAME span — so any content tally
  // that mixes tiers double-counts the scene (once as leaves, again as the rollup). Content analytics
  // (keywords / co-occurrence / themes) use the tier-0 LEAVES only. Then collapse by contentHash (B.5.1)
  // so a forked chat's shared scenes don't double-count either. (tier 1+ have null contentHash anyway.)
  const digestRows = await db.all<{ contentHash: string | null; keywords: string | null }>(sql`
    SELECT cd.content_hash AS contentHash, cd.keywords AS keywords
    FROM chat_digests cd
    JOIN chats ch ON ch.id = cd.chat_id
    JOIN character_versions cv ON cv.id = ch.character_version_id
    WHERE cv.character_id = ${characterId} AND cd.owner_id = ${ownerId} AND cd.tier = 0
  `);
  const { representatives } = collapseByContentHash(digestRows);
  const tally = new Map<string, number>();
  for (const row of representatives) {
    for (const kw of parseKeywords(row.keywords)) {
      const k = kw.trim().toLowerCase();
      if (k.length >= 3) tally.set(k, (tally.get(k) ?? 0) + 1);
    }
  }
  const topKeywords = [...tally.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 25);

  return {
    characterId,
    name: h.name,
    refineryScore: h.refineryScore,
    chats: a.chats,
    messages: a.messages,
    userMessages: a.userMessages,
    charMessages: a.charMessages,
    tokensOut: a.tokensOut,
    firstAt: a.firstAt,
    lastAt: a.lastAt,
    digests: representatives.length,
    models,
    topKeywords,
  };
}
