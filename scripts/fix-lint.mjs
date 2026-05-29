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

    // Fix imports: separate expect and test
    content = content.replace(
      /import\s+\{\s*expect,\s*test\s*\}\s+from\s+["']\.\.\/support\/fixtures["'];?/g,
      `import { test } from "../support/fixtures";\nimport { expect } from "vitest";`,
    );

    // Fix makePersona type in persona-pin.test.ts
    content = content.replace(/db:\s*Awaited<ReturnType<typeof freshDb>>/g, "db: any");

    await fs.writeFile(p, content, "utf8");
  }

  // Fix fixtures.ts
  const fp = fileURLToPath(new URL("../tests/support/fixtures.ts", import.meta.url));
  let fc = await fs.readFile(fp, "utf8");
  fc = fc.replace(/async\s*\(\{\},\s*use\)\s*=>/g, "async (_args, use) =>");
  fc = fc.replace(/export\s+\{\s*expect\s*\}\s+from\s+["']vitest["'];?/g, "");
  await fs.writeFile(fp, fc, "utf8");
}

main().catch(console.error);
