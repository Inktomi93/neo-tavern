import type { Db } from "../../../db/client";
import { characterKeywords } from "./cooccurrence";
import { characterSummary } from "./distill";
import { readDuplicateCharacters, readDuplicateChats, similarCharacters } from "./duplicates";
import { type CharacterProfile, characterProfile, corpusStats } from "./stats";
import {
  characterThemeProfile,
  type ThemeRow,
  themeCharacters,
  themes,
  themeTimeline,
} from "./themes";

// Composed "page" views — each bundles the several reads ONE front-end surface needs into a single
// call (and resolves the owner once), so the API is a handful of coherent endpoints instead of ~25
// granular ones. Pure composition over the domain read functions; no new queries of their own.

export interface HomeView {
  totals: {
    characters: number;
    chats: number;
    messages: number;
    digests: number;
    segments: number;
  };
  topCharacters: { characterId: string; name: string; chats: number; messages: number }[];
  byModel: { model: string; messages: number }[];
  timeline: { day: string; messages: number }[];
  byHour: { hour: number; messages: number }[];
  topSceneThemes: ThemeRow[];
  topArcThemes: ThemeRow[];
  duplicateCounts: { characters: number; chats: number };
}

/** The corpus home: most-RP'd characters + activity timeline + top scene/arc themes + cleanup counts. */
export async function homeView(db: Db, ownerId: string): Promise<HomeView> {
  const [stats, sceneThemes, arcThemes, dupChars, dupChats] = await Promise.all([
    corpusStats(db, ownerId),
    themes(db, ownerId, "scene"),
    themes(db, ownerId, "arc"),
    readDuplicateCharacters(db, ownerId),
    readDuplicateChats(db, ownerId, { includeForked: false }),
  ]);
  return {
    totals: stats.totals,
    topCharacters: stats.topCharacters.slice(0, 10),
    byModel: stats.byModel,
    timeline: stats.timeline,
    byHour: stats.byHour,
    topSceneThemes: sceneThemes.slice(0, 8),
    topArcThemes: arcThemes.slice(0, 8),
    duplicateCounts: { characters: dupChars.length, chats: dupChats.length },
  };
}

export interface CharacterDossier {
  profile: CharacterProfile;
  summary: Awaited<ReturnType<typeof characterSummary>>;
  keywords: { keyword: string; count: number }[];
  sceneThemes: { clusterIdx: number; themeName: string; count: number }[];
  arcThemes: { clusterIdx: number; themeName: string; count: number }[];
  similar: { characterId: string; name: string; similarity: number }[];
}

/** Everything a character page wants: profile + distillation + keywords + scene/arc themes + similar. */
export async function characterDossier(
  db: Db,
  ownerId: string,
  characterId: string,
): Promise<CharacterDossier | null> {
  const profile = await characterProfile(db, ownerId, characterId);
  if (!profile) return null;
  const [summary, keywords, sceneThemes, arcThemes, similar] = await Promise.all([
    characterSummary(db, ownerId, characterId),
    characterKeywords(db, ownerId, characterId, 25),
    characterThemeProfile(db, ownerId, characterId, "scene"),
    characterThemeProfile(db, ownerId, characterId, "arc"),
    similarCharacters(db, characterId, ownerId, 8),
  ]);
  return { profile, summary, keywords, sceneThemes, arcThemes, similar };
}

export interface ThemeDetail extends ThemeRow {
  level: "scene" | "arc";
  timeline: { bucket: string; count: number }[];
  characters: { characterId: string; name: string; count: number }[];
}

/** One theme's detail: its facets + story-time timeline + the characters most present in it. */
export async function themeDetail(
  db: Db,
  ownerId: string,
  clusterIdx: number,
  level: "scene" | "arc",
): Promise<ThemeDetail | null> {
  const list = await themes(db, ownerId, level);
  const theme = list.find((t) => t.clusterIdx === clusterIdx);
  if (!theme) return null;
  const [timeline, characters] = await Promise.all([
    themeTimeline(db, ownerId, clusterIdx, 30, level),
    themeCharacters(db, ownerId, clusterIdx, 15, level),
  ]);
  return { ...theme, level, timeline, characters };
}
