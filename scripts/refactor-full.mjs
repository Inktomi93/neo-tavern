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
      /import\s+\{([^}]*?)(expect|test)([^}]*?)\}\s+from\s+["']vitest["'];?/g,
      (match) => {
        if (match.includes("test") && match.includes("expect")) {
          return `import { test } from "../support/fixtures";\nimport { expect${match.includes("describe") ? ", describe" : ""}${match.includes("beforeEach") ? ", beforeEach" : ""}${match.includes("afterEach") ? ", afterEach" : ""} } from "vitest";`;
        }
        return match;
      },
    );
    if (!content.includes("import { test }")) {
      content = content.replace(
        /import \{ expect.*?\} from "vitest";/,
        `import { test } from "../support/fixtures";\n$&`,
      );
    }

    // Replace async function setup() ...
    content = content.replace(
      /async\s+function\s+(setup|createTestCaller)[\s\S]*?(return\s+\{[\s\S]*?\};?\s*)\n\}/g,
      "",
    );

    // Remove calls to setup() and createTestCaller()
    content = content.replace(
      /^[ \t]*const\s+\{[\s\S]*?\}\s*=\s*await\s+(setup|createTestCaller)\(.*?\);?\n/gm,
      "",
    );

    // Inject parameters into test signatures based on what the file needs
    const needsCaller = content.includes("caller.") || content.includes("caller)");
    const needsOtherCaller = content.includes("otherCaller.");
    const needsDb = content.includes("db") && !file.includes("assets-http");

    const params = [];
    if (needsCaller) params.push("caller");
    if (needsOtherCaller) params.push("otherCaller");
    if (needsDb) params.push("db");

    const paramStr = params.length > 0 ? `{ ${params.join(", ")} }` : "";
    content = content.replace(
      /test\((["'`].*?["'`]),\s*async\s*\(\)\s*=>\s*\{/g,
      `test($1, async (${paramStr}) => {`,
    );

    // Remove freshDb import and direct calls
    content = content.replace(
      /import\s+\{\s*freshDb\s*\}\s+from\s+["']\.\.\/support\/db["'];?\n?/g,
      "",
    );
    content = content.replace(/^[ \t]*const\s+db\s*=\s*await\s+freshDb\(\);?\n/gm, "");

    await fs.writeFile(p, content, "utf8");
    console.log(`Refactored ${file}`);
  }
}

main().catch(console.error);
