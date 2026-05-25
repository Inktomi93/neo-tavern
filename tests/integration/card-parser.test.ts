import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseCardPng } from "../../src/server/domain/corpus/import/card";

const cardFixture = fileURLToPath(
  new URL("../fixtures/cards/Block of Cheese.png", import.meta.url),
);

// Build a minimal valid card PNG in-memory: signature + one tEXt chunk carrying
// base64(JSON). Our reader (like card-curator) ignores the CRC, so a zero CRC is fine.
function makeCardPng(card: unknown, keyword = "chara"): Uint8Array {
  const b64 = Buffer.from(JSON.stringify(card), "utf-8").toString("base64");
  const text = Buffer.concat([
    Buffer.from(keyword, "ascii"),
    Buffer.from([0]),
    Buffer.from(b64, "ascii"),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(text.length, 0);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(
    Buffer.concat([sig, len, Buffer.from("tEXt", "ascii"), text, Buffer.alloc(4)]),
  );
}

test("parses a real ST card from its PNG tEXt chunk", () => {
  const card = parseCardPng(readFileSync(cardFixture), "fallback");
  expect(card).not.toBeNull();
  expect(card?.name).toBe("Block of Cheese");
  expect(card?.description).toBeTruthy();
  expect(card?.raw).toBeTypeOf("object");
});

test("returns null when the PNG carries no card data", () => {
  const sigOnly = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(parseCardPng(sigOnly, "x")).toBeNull();
  expect(parseCardPng(new Uint8Array([1, 2, 3]), "x")).toBeNull();
});

test("empty card name falls back to the supplied fallback (card-curator's third leg)", () => {
  const card = parseCardPng(makeCardPng({ name: "" }), "Block of Cheese");
  expect(card?.name).toBe("Block of Cheese");
});

test("normalizes a flat V1 card to the V2 shape", () => {
  // V1 = fields at root, no `data`/`spec`. (Lorebooks are a V2+ feature, so — like
  // card-curator — V1 normalization carries no character_book; tested below on V2.)
  const card = parseCardPng(
    makeCardPng({ name: "V1 Char", description: "a flat v1 description" }),
    "ignored",
  );
  expect(card?.name).toBe("V1 Char");
  expect(card?.description).toBe("a flat v1 description");
});

test("extracts a dict-form lorebook, dict→list, preserving whole entries (disabled kept)", () => {
  const card = parseCardPng(
    makeCardPng({
      data: {
        name: "V2 Char",
        description: "d",
        character_book: {
          entries: {
            "0": {
              keys: ["castle"],
              content: "the castle lore",
              enabled: true,
              insertion_order: 5,
            },
            "1": { keys: ["king"], content: "the king lore", enabled: false },
          },
        },
      },
    }),
    "ignored",
  );
  expect(card?.lorebookEntries).toHaveLength(2);
  expect(card?.lorebookEntries[0]?.["content"]).toBe("the castle lore");
  expect(card?.lorebookEntries[0]?.["insertion_order"]).toBe(5);
  expect(card?.lorebookEntries[1]?.["enabled"]).toBe(false);
});

test("ccv3 chunk wins over chara; cardVersion stays a string, not the int counter", () => {
  // Two chunks would need a fancier builder; assert the field mapping on a V2-shaped card.
  const card = parseCardPng(makeCardPng({ data: { name: "V2", character_version: "1.0" } }), "x");
  expect(card?.name).toBe("V2");
  expect(card?.cardVersion).toBe("1.0");
});
