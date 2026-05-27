import process from "node:process";
import { OpenRouter } from "@openrouter/sdk";
import { env } from "../src/server/env";

/** Discovery: list OpenRouter embedding models + pricing so we pick real IDs for the cost test. */
async function main(): Promise<void> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
  const client = new OpenRouter({ apiKey });

  const res = await client.embeddings.listModels();
  // biome-ignore lint/suspicious/noExplicitAny: probing dynamic API response shape.
  const data = (res as any).data ?? (res as any).models ?? res;
  const rows = Array.isArray(data) ? data : [];
  console.log(`=== embedding models (${rows.length}) ===`);
  for (const m of rows) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic shape.
    const mm = m as any;
    const id = mm.id ?? mm.slug ?? "?";
    const pricing = mm.pricing ? JSON.stringify(mm.pricing) : "";
    const ctx = mm.context_length ?? mm.contextLength ?? "";
    console.log(`  ${id}  ctx=${ctx}  ${pricing}`);
  }
}

await main()
  .catch((e: unknown) => {
    console.error("models probe failed:", e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
