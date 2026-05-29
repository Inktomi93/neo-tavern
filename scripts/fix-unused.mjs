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

    // Replace unused args manually mapped to test files
    if (file === "chat-memory.test.ts") {
      content = content.replace(/async\s*\(\{\s*db\s*\}\)\s*=>/g, "async () =>");
    }
    if (file === "import-loader.test.ts") {
      content = content.replace(/async\s*\(\{\s*db\s*\}\)\s*=>/g, "async () =>");
      content = content.replace(/async\s*\(\{\s*db,\s*\}\)\s*=>/g, "async () =>");
    }
    if (file === "persona-router.test.ts") {
      content = content.replace(
        /async\s*\(\{\s*caller,\s*db\s*\}\)\s*=>/g,
        "async ({ caller }) =>",
      );
    }
    if (file === "settings-router.test.ts") {
      content = content.replace(
        /async\s*\(\{\s*caller,\s*otherCaller,\s*db\s*\}\)\s*=>/g,
        "async ({ caller, otherCaller }) =>",
      );
      content = content.replace(
        /test\("global settings CRUD",\s*async\s*\(\{\s*caller,\s*otherCaller\s*\}\)\s*=>/g,
        'test("global settings CRUD", async ({ caller }) =>',
      );
    }
    if (file === "tag-router.test.ts") {
      content = content.replace(
        /async\s*\(\{\s*caller,\s*otherCaller,\s*db\s*\}\)\s*=>/g,
        "async ({ caller, otherCaller }) =>",
      );
      content = content.replace(
        /test\("tag attachment",\s*async\s*\(\{\s*caller,\s*otherCaller\s*\}\)\s*=>/g,
        'test("tag attachment", async ({ caller, db }) =>',
      );
    }
    if (
      file === "search-digests.test.ts" ||
      file === "search-discover.test.ts" ||
      file === "search-find.test.ts" ||
      file === "search-segments.test.ts"
    ) {
      content = content.replace(/async\s*\(\{\s*db\s*\}\)\s*=>/g, "async () =>");
    }

    await fs.writeFile(p, content, "utf8");
  }
}
main().catch(console.error);
