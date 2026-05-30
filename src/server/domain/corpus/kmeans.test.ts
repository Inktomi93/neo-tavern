import { describe, expect, it } from "vitest";
import { cosineDistance, kmeans } from "./kmeans";
import { parseThemeName } from "./themes";

// Build a small vector in a low dim (kmeans reads dim from the data, not a hardcoded 1024).
function v(...xs: number[]): Float32Array {
  return Float32Array.from(xs);
}

describe("kmeans", () => {
  it("separates three well-defined clusters", () => {
    // Three tight blobs at distinct DIRECTIONS (kmeans normalizes → cosine space, so angle is what
    // separates, like real embeddings — not proximity to the origin).
    const pts = [
      v(10, 0), // ~ (1, 0)
      v(10, 0.5),
      v(9.5, 0),
      v(0, 10), // ~ (0, 1)
      v(0.5, 10),
      v(0, 9.5),
      v(-10, -10), // ~ (-0.7, -0.7)
      v(-10, -9.5),
      v(-9.5, -10),
    ];
    const { assignments, sizes, inertia } = kmeans(pts, 3, { seed: 7 });
    // Each blob's three points share a cluster.
    expect(assignments[0]).toBe(assignments[1]);
    expect(assignments[1]).toBe(assignments[2]);
    expect(assignments[3]).toBe(assignments[4]);
    expect(assignments[6]).toBe(assignments[8]);
    // Three non-empty clusters.
    expect(sizes.filter((s) => s > 0)).toHaveLength(3);
    expect(inertia).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for a fixed seed", () => {
    const pts = Array.from({ length: 20 }, (_, i) => v(i % 5, Math.floor(i / 5)));
    const a = kmeans(pts, 4, { seed: 42 });
    const b = kmeans(pts, 4, { seed: 42 });
    expect(a.assignments).toEqual(b.assignments);
  });

  it("caps k at the number of points", () => {
    const pts = [v(1, 0), v(0, 1)];
    const { centroids } = kmeans(pts, 5, { seed: 1 });
    expect(centroids.length).toBeLessThanOrEqual(2);
  });
});

describe("cosineDistance", () => {
  it("is 0 for parallel and 1 for orthogonal vectors", () => {
    expect(cosineDistance(v(1, 0), v(2, 0))).toBeCloseTo(0, 6);
    expect(cosineDistance(v(1, 0), v(0, 1))).toBeCloseTo(1, 6);
  });
});

describe("parseThemeName", () => {
  it("parses a well-formed object", () => {
    const r = parseThemeName(
      'prose {"themeName":"Forbidden Intimacy","subThemes":["trust","vulnerability"],"description":"X."} trailing',
      3,
    );
    expect(r.themeName).toBe("Forbidden Intimacy");
    expect(r.subThemes).toEqual(["trust", "vulnerability"]);
    expect(r.description).toBe("X.");
  });
  it("falls back on garbage", () => {
    expect(parseThemeName("not json", 5)).toEqual({
      themeName: "Theme 5",
      subThemes: [],
      description: "",
    });
  });
});
