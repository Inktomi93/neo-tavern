import process from "node:process";
import { createDb } from "../src/db/client";
import { runImageEmbedPass } from "../src/server/domain/assets/embed-pass";
import { env } from "../src/server/env";

async function main() {
  console.log("Starting visual embedding pass for assets...");
  try {
    const db = await createDb(env.DATABASE_URL);
    await runImageEmbedPass(db, env.ASSETS_DIR);
    console.log("Visual embedding pass complete.");
    process.exit(0);
  } catch (err) {
    console.error("Fatal error during visual embedding pass:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error during visual embedding pass:", err);
  process.exit(1);
});
