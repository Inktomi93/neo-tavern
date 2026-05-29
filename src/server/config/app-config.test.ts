import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db, runMigrations } from "../../db/client";
import { settings } from "../../db/schema";
import { env } from "../env";
import {
  __resetAppConfigCache,
  APP_SETTINGS_KEY,
  getAppConfig,
  reloadAppConfig,
} from "./app-config";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
  await runMigrations(db);
  __resetAppConfigCache();
});

async function storeOverride(value: Record<string, unknown>): Promise<void> {
  await db.insert(settings).values({ key: APP_SETTINGS_KEY, value, updatedAt: Date.now() });
}

describe("app-config resolver", () => {
  test("before any reload, getAppConfig is the env floor", () => {
    const cfg = getAppConfig();
    expect(cfg.corpusAutoindex).toBe(env.CORPUS_AUTOINDEX === "true");
    expect(cfg.idleUnloadMin).toBe(env.IDLE_UNLOAD_MIN);
    expect(cfg.logLevel).toBe(env.LOG_LEVEL);
    // env's comma string is normalized into a trimmed array.
    expect(cfg.importSkipCharacters).toEqual(
      env.IMPORT_SKIP_CHARACTERS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  });

  test("a stored override wins; unset fields fall through to env", async () => {
    await storeOverride({ corpusAutoindex: false, logLevel: "debug" });
    const cfg = await reloadAppConfig(db);
    expect(cfg.corpusAutoindex).toBe(false); // overridden
    expect(cfg.logLevel).toBe("debug"); // overridden
    expect(cfg.idleUnloadMin).toBe(env.IDLE_UNLOAD_MIN); // untouched → env default
  });

  test("reload busts the in-process cache (getAppConfig reflects the new override)", async () => {
    await reloadAppConfig(db); // env floor
    expect(getAppConfig().corpusAutoindex).toBe(env.CORPUS_AUTOINDEX === "true");
    await storeOverride({ corpusAutoindex: false });
    await reloadAppConfig(db);
    expect(getAppConfig().corpusAutoindex).toBe(false);
  });

  test("a garbage override blob degrades to the env floor (never throws)", async () => {
    await storeOverride({ corpusAutoindex: "yes-please", idleUnloadMin: -9 });
    const cfg = await reloadAppConfig(db);
    expect(cfg.corpusAutoindex).toBe(env.CORPUS_AUTOINDEX === "true");
    expect(cfg.idleUnloadMin).toBe(env.IDLE_UNLOAD_MIN);
  });
});
