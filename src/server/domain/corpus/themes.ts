import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { chatDigests, digestThemeAssignments, themeClusters } from "../../../db/schema";
import { collapseByContentHash } from "../../../shared/content-hash";
import type { Summarizer } from "../../embeddings/summarizer";
import { getLog } from "../../observability/logger";
import { newId } from "../_shared/ids";
import { cosineDistance, kmeans } from "./kmeans";

// Emergent THEMES (Pillar B — docs/planning/breadth-buildout.md B.4). k-means over the tier-0 digest
// embeddings surfaces themes nobody labeled; an LLM NAMES each cluster. Centroids computed on the
// contentHash-COLLAPSED set (a forked scene doesn't bias a centroid); EVERY tier-0 digest is then
// assigned to its nearest centroid (full coverage incl. dups, so the timeline/profiles are complete).

// Grammar-constrained naming output — same mechanism as DIGEST_SCHEMA: the local GGUF path is GBNF-
// constrained to this shape (the sampler can't emit a non-conforming token); the hosted path is prompted
// for the same JSON. Bounded arrays so a verbose small model can't overflow.
export const THEME_NAMING_SCHEMA = {
  type: "object",
  properties: {
    themeName: { type: "string" },
    subThemes: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 6 },
    description: { type: "string" },
  },
  required: ["themeName", "subThemes", "description"],
};

const THEME_NAMING_SYSTEM = `You name emergent themes in a roleplay corpus. Given several scene labels that a clustering algorithm grouped together, name the SINGLE theme they share.

Respond with ONLY a JSON object of this exact shape (no prose, no markdown, no <think>):
{"themeName": "...", "subThemes": ["...", "..."], "description": "..."}

- themeName: a short, evocative title (2-5 words) for what these scenes have in common — the through-line, not a list.
- subThemes: 0-6 short facets within the theme (distinct angles the scenes take on it).
- description: one sentence describing the theme.`;

const NAMING_SAMPLE = 6; // centroid-nearest anchors shown to the namer per cluster

export interface ThemeComputeStats {
  clusters: number;
  digestsClustered: number;
  inertia: number;
  msgMidAtBackfilled: number;
}

interface ComputeThemesDeps {
  summarizer: Summarizer;
}

/**
 * Backfill `chat_digests.msg_mid_at` (story-time axis, B.4) for tier-0 rows that lack it: the midpoint
 * message createdAt of the digest's seqStart..seqEnd span. Idempotent (only null rows). Returns count.
 */
export async function backfillMsgMidAt(db: Db): Promise<number> {
  const rows = await db.all<{ id: string; chatId: string; seqStart: number; seqEnd: number }>(sql`
    SELECT id, chat_id AS chatId, seq_start AS seqStart, seq_end AS seqEnd
    FROM chat_digests WHERE tier = 0 AND msg_mid_at IS NULL
  `);
  let written = 0;
  for (const r of rows) {
    const mids = await db.all<{ createdAt: number }>(sql`
      SELECT created_at AS createdAt FROM messages
      WHERE chat_id = ${r.chatId} AND seq >= ${r.seqStart} AND seq <= ${r.seqEnd}
      ORDER BY seq ASC
    `);
    if (mids.length === 0) continue;
    const mid = mids[Math.floor(mids.length / 2)]?.createdAt ?? mids[0]?.createdAt;
    if (mid === undefined) continue;
    await db.update(chatDigests).set({ msgMidAt: mid }).where(eq(chatDigests.id, r.id));
    written += 1;
  }
  return written;
}

/** Recompute themes for every owner with tier-0 digests. Idempotent (replaces the owner's rows). */
export async function computeThemes(
  db: Db,
  deps: ComputeThemesDeps,
  opts: { k?: number; seed?: number } = {},
): Promise<ThemeComputeStats> {
  const k = opts.k ?? 30;
  const now = Date.now();
  const msgMidAtBackfilled = await backfillMsgMidAt(db);

  const owners = (
    await db.all<{ ownerId: string }>(sql`SELECT DISTINCT owner_id AS ownerId FROM chat_digests`)
  ).map((r) => r.ownerId);

  let totalClusters = 0;
  let totalDigests = 0;
  let totalInertia = 0;

  for (const ownerId of owners) {
    const rows = await db
      .select({
        id: chatDigests.id,
        model: chatDigests.model,
        topicAnchor: chatDigests.topicAnchor,
        contentHash: chatDigests.contentHash,
        embedding: chatDigests.embedding,
      })
      .from(chatDigests)
      .where(and(eq(chatDigests.ownerId, ownerId), eq(chatDigests.tier, 0)));

    const withVec = rows.filter(
      (r): r is typeof r & { embedding: Float32Array } => r.embedding !== null,
    );
    if (withVec.length < k + 1) continue; // too few to cluster meaningfully
    const model = withVec[0]?.model ?? "unknown";

    // Cluster on the CONTENT-COLLAPSED set so a forked scene doesn't bias a centroid (B.5.1).
    const reps = collapseByContentHash(withVec).representatives;
    const km = kmeans(
      reps.map((r) => r.embedding),
      k,
      { seed: opts.seed ?? 1 },
    );
    totalInertia += km.inertia;

    // Name each cluster from its centroid-nearest representative anchors (grammar-constrained).
    const named: { themeName: string; subThemes: string[]; description: string }[] = [];
    for (let c = 0; c < km.centroids.length; c += 1) {
      const centroid = km.centroids[c] as Float32Array;
      const anchors = reps
        .map((r) => ({ anchor: r.topicAnchor ?? "", dist: cosineDistance(r.embedding, centroid) }))
        .filter((a) => a.anchor.length > 0)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, NAMING_SAMPLE)
        .map((a) => a.anchor);
      named.push(await nameCluster(deps.summarizer, anchors, c));
    }

    // Assign EVERY tier-0 digest (incl. content dups) to its nearest centroid — full timeline coverage.
    const assignments = withVec.map((r) => {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < km.centroids.length; c += 1) {
        const dd = cosineDistance(r.embedding, km.centroids[c] as Float32Array);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      return { digestId: r.id, clusterIdx: best, distance: bestD };
    });
    const memberCounts = new Array<number>(km.centroids.length).fill(0);
    for (const a of assignments) memberCounts[a.clusterIdx] = (memberCounts[a.clusterIdx] ?? 0) + 1;

    // Replace this owner's rows.
    await db.delete(themeClusters).where(eq(themeClusters.ownerId, ownerId));
    await db.delete(digestThemeAssignments).where(eq(digestThemeAssignments.ownerId, ownerId));
    for (let c = 0; c < km.centroids.length; c += 1) {
      const nm = named[c] ?? { themeName: `Theme ${c}`, subThemes: [], description: "" };
      await db.insert(themeClusters).values({
        id: newId(),
        ownerId,
        model,
        clusterIdx: c,
        themeName: nm.themeName,
        subThemes: nm.subThemes,
        description: nm.description,
        centroid: km.centroids[c] as Float32Array,
        memberCount: memberCounts[c] ?? 0,
        computedAt: now,
      });
    }
    for (const a of assignments) {
      await db.insert(digestThemeAssignments).values({
        digestId: a.digestId,
        ownerId,
        clusterIdx: a.clusterIdx,
        distance: a.distance,
        computedAt: now,
      });
    }
    totalClusters += km.centroids.length;
    totalDigests += assignments.length;
  }

  const stats: ThemeComputeStats = {
    clusters: totalClusters,
    digestsClustered: totalDigests,
    inertia: totalInertia,
    msgMidAtBackfilled,
  };
  getLog().info(stats, "corpus: themes computed");
  return stats;
}

async function nameCluster(
  summarizer: Summarizer,
  anchors: string[],
  idx: number,
): Promise<{ themeName: string; subThemes: string[]; description: string }> {
  if (anchors.length === 0) return { themeName: `Theme ${idx}`, subThemes: [], description: "" };
  const userPrompt = `These scene labels were clustered together:\n${anchors.map((a) => `- ${a}`).join("\n")}\n\nName their shared theme:`;
  const res = await summarizer.summarize(THEME_NAMING_SYSTEM, userPrompt, {
    jsonSchema: THEME_NAMING_SCHEMA, // grammar-constrain the local path; hosted is prompted for it
    maxTokens: 256,
    temperature: 0.3,
  });
  return parseThemeName(res.text, idx);
}

export function parseThemeName(
  raw: string,
  idx: number,
): { themeName: string; subThemes: string[]; description: string } {
  const fallback = { themeName: `Theme ${idx}`, subThemes: [] as string[], description: "" };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  try {
    const o: unknown = JSON.parse(raw.slice(start, end + 1));
    if (typeof o !== "object" || o === null) return fallback;
    const obj = o as { themeName?: unknown; subThemes?: unknown; description?: unknown };
    const themeName =
      typeof obj.themeName === "string" && obj.themeName.trim()
        ? obj.themeName.trim()
        : fallback.themeName;
    const subThemes = Array.isArray(obj.subThemes)
      ? obj.subThemes.filter((x): x is string => typeof x === "string")
      : [];
    const description = typeof obj.description === "string" ? obj.description.trim() : "";
    return { themeName, subThemes, description };
  } catch {
    return fallback;
  }
}

// ── reads (live tRPC) ────────────────────────────────────────────────────────

export interface ThemeRow {
  clusterIdx: number;
  themeName: string;
  subThemes: string[];
  description: string | null;
  memberCount: number;
}

export async function themes(db: Db, ownerId: string): Promise<ThemeRow[]> {
  const rows = await db.all<{
    clusterIdx: number;
    themeName: string;
    subThemes: string | null;
    description: string | null;
    memberCount: number;
  }>(sql`
    SELECT cluster_idx AS clusterIdx, theme_name AS themeName, sub_themes AS subThemes,
           description, member_count AS memberCount
    FROM theme_clusters WHERE owner_id = ${ownerId} ORDER BY member_count DESC
  `);
  return rows.map((r) => ({
    clusterIdx: r.clusterIdx,
    themeName: r.themeName,
    subThemes: parseJsonStringArray(r.subThemes),
    description: r.description,
    memberCount: r.memberCount,
  }));
}

/** Theme activity over STORY time — digests in the cluster bucketed by msgMidAt (B.4 timeline). */
export async function themeTimeline(
  db: Db,
  ownerId: string,
  clusterIdx: number,
  bucketDays = 7,
): Promise<{ bucket: string; count: number }[]> {
  const bucketMs = bucketDays * 86_400_000;
  return db.all<{ bucket: string; count: number }>(sql`
    SELECT strftime('%Y-%m-%d', (cd.msg_mid_at / ${bucketMs}) * ${bucketMs} / 1000, 'unixepoch') AS bucket,
           COUNT(*) AS count
    FROM digest_theme_assignments dta
    JOIN chat_digests cd ON cd.id = dta.digest_id
    WHERE dta.owner_id = ${ownerId} AND dta.cluster_idx = ${clusterIdx} AND cd.msg_mid_at IS NOT NULL
    GROUP BY bucket ORDER BY bucket
  `);
}

/** Which themes a character's chats touch, by digest count. */
export async function characterThemeProfile(
  db: Db,
  ownerId: string,
  characterId: string,
): Promise<{ clusterIdx: number; themeName: string; count: number }[]> {
  return db.all<{ clusterIdx: number; themeName: string; count: number }>(sql`
    SELECT tc.cluster_idx AS clusterIdx, tc.theme_name AS themeName, COUNT(*) AS count
    FROM digest_theme_assignments dta
    JOIN chat_digests cd ON cd.id = dta.digest_id
    JOIN chats ch ON ch.id = cd.chat_id
    JOIN character_versions cv ON cv.id = ch.character_version_id
    JOIN theme_clusters tc ON tc.owner_id = dta.owner_id AND tc.cluster_idx = dta.cluster_idx
    WHERE dta.owner_id = ${ownerId} AND cv.character_id = ${characterId}
    GROUP BY tc.cluster_idx ORDER BY count DESC
  `);
}

/** The characters most present in a theme. */
export async function themeCharacters(
  db: Db,
  ownerId: string,
  clusterIdx: number,
  limit = 15,
): Promise<{ characterId: string; name: string; count: number }[]> {
  return db.all<{ characterId: string; name: string; count: number }>(sql`
    SELECT cv.character_id AS characterId, MIN(cv.name) AS name, COUNT(*) AS count
    FROM digest_theme_assignments dta
    JOIN chat_digests cd ON cd.id = dta.digest_id
    JOIN chats ch ON ch.id = cd.chat_id
    JOIN character_versions cv ON cv.id = ch.character_version_id
    WHERE dta.owner_id = ${ownerId} AND dta.cluster_idx = ${clusterIdx}
    GROUP BY cv.character_id ORDER BY count DESC LIMIT ${limit}
  `);
}

function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
