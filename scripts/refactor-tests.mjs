import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../tests/integration", import.meta.url));

async function main() {
  const files = await fs.readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".test.ts")) continue;

    const p = path.join(dir, file);
    let content = await fs.readFile(p, "utf8");

    // Replace vitest import
    content = content.replace(
      /import\s+\{.*?(test|expect).*?\}\s+from\s+["']vitest["'];?/g,
      `import { expect, test } from "../support/fixtures";`,
    );

    // Remove freshDb import
    content = content.replace(
      /import\s+\{\s*freshDb\s*\}\s+from\s+["']\.\.\/support\/db["'];?\n?/g,
      "",
    );

    // Replace test signatures
    content = content.replace(
      /test\((["'`].*?["'`]),\s*async\s*\(\)\s*=>\s*\{/g,
      "test($1, async ({ db }) => {",
    );

    // Remove const db = await freshDb();
    content = content.replace(/^[ \t]*const\s+db\s*=\s*await\s+freshDb\(\);?\n/gm, "");

    await fs.writeFile(p, content, "utf8");
    console.log(`Refactored ${file}`);
  }
}

main().catch(console.error);
