// Pure-TS k-means over Float32Array vectors (docs/planning/breadth-buildout.md B.4) — the emergent
// theme-clustering core. Same in-process style as hubness's matmul; ~1s at 2,500×1024×k=30. Vectors are
// L2-normalized first, so squared-Euclidean ranks identically to cosine distance (the embedding space).
// k-means++ init + a small seeded PRNG so a run is deterministic (testable; no Math.random).

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function normalize(vecs: readonly Float32Array[], dim: number): Float32Array[] {
  return vecs.map((v) => {
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += (v[d] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    const out = new Float32Array(dim);
    for (let d = 0; d < dim; d += 1) out[d] = (v[d] ?? 0) / norm;
    return out;
  });
}

function sqDist(a: Float32Array, b: Float32Array, dim: number): number {
  let s = 0;
  for (let d = 0; d < dim; d += 1) {
    const diff = (a[d] ?? 0) - (b[d] ?? 0);
    s += diff * diff;
  }
  return s;
}

export interface KMeansResult {
  /** Cluster index (0..k-1) per input point. */
  assignments: number[];
  /** The k centroids (each `dim`-long). */
  centroids: Float32Array[];
  /** Sum of squared distances of each point to its centroid (the elbow metric). */
  inertia: number;
  /** Members per cluster. */
  sizes: number[];
}

/**
 * k-means (Lloyd) with k-means++ seeding. Normalizes inputs so distance ≈ cosine. Empty clusters are
 * re-seeded to the farthest point (avoids collapse). Deterministic given `seed`.
 */
export function kmeans(
  vecs: readonly Float32Array[],
  k: number,
  opts: { maxIters?: number; seed?: number } = {},
): KMeansResult {
  const maxIters = opts.maxIters ?? 50;
  const rand = lcg(opts.seed ?? 1);
  const n = vecs.length;
  const dim = vecs[0]?.length ?? 0;
  const kk = Math.min(k, n);
  const pts = normalize(vecs, dim);

  // ── k-means++ init ──────────────────────────────────────────────────────────
  const centroids: Float32Array[] = [];
  const first = Math.floor(rand() * n);
  centroids.push(Float32Array.from(pts[first] ?? new Float32Array(dim)));
  const d2 = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  while (centroids.length < kk) {
    let total = 0;
    const last = centroids[centroids.length - 1] as Float32Array;
    for (let i = 0; i < n; i += 1) {
      const di = sqDist(pts[i] as Float32Array, last, dim);
      if (di < (d2[i] ?? Number.POSITIVE_INFINITY)) d2[i] = di;
      total += d2[i] ?? 0;
    }
    let target = rand() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i += 1) {
      target -= d2[i] ?? 0;
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(Float32Array.from(pts[chosen] ?? new Float32Array(dim)));
  }

  // ── Lloyd iterations ────────────────────────────────────────────────────────
  const assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIters; iter += 1) {
    let moved = 0;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c += 1) {
        const dc = sqDist(pts[i] as Float32Array, centroids[c] as Float32Array, dim);
        if (dc < bestD) {
          bestD = dc;
          best = c;
        }
      }
      if (assignments[i] !== best) moved += 1;
      assignments[i] = best;
    }
    // Recompute centroids = mean of members.
    const sums = Array.from({ length: centroids.length }, () => new Float32Array(dim));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assignments[i] ?? 0;
      const s = sums[c] as Float32Array;
      const p = pts[i] as Float32Array;
      for (let d = 0; d < dim; d += 1) s[d] = (s[d] ?? 0) + (p[d] ?? 0);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    for (let c = 0; c < centroids.length; c += 1) {
      const cnt = counts[c] ?? 0;
      if (cnt === 0) {
        // Re-seed an empty cluster to the point farthest from its current centroid.
        let far = 0;
        let farD = -1;
        for (let i = 0; i < n; i += 1) {
          const dd = sqDist(
            pts[i] as Float32Array,
            centroids[assignments[i] ?? 0] as Float32Array,
            dim,
          );
          if (dd > farD) {
            farD = dd;
            far = i;
          }
        }
        centroids[c] = Float32Array.from(pts[far] ?? new Float32Array(dim));
        continue;
      }
      const s = sums[c] as Float32Array;
      const out = new Float32Array(dim);
      for (let d = 0; d < dim; d += 1) out[d] = (s[d] ?? 0) / cnt;
      centroids[c] = out;
    }
    if (moved === 0 && iter > 0) break;
  }

  let inertia = 0;
  const sizes = new Array<number>(centroids.length).fill(0);
  for (let i = 0; i < n; i += 1) {
    const c = assignments[i] ?? 0;
    inertia += sqDist(pts[i] as Float32Array, centroids[c] as Float32Array, dim);
    sizes[c] = (sizes[c] ?? 0) + 1;
  }
  return { assignments, centroids, inertia, sizes };
}

/** Cosine distance (1 − cos) between two vectors, assuming neither is zero. For assignment provenance. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  const dim = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < dim; d += 1) {
    const x = a[d] ?? 0;
    const y = b[d] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return 1 - dot / denom;
}
