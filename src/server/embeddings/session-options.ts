import { env } from "../env";

/**
 * ONNX session options shared by all local embedding models.
 *
 * graphOptimizationLevel "all" everywhere — enables ORT transformer fusions (Attention / LayerNorm /
 * GELU). On CUDA we also pin the physical GPU via an explicit executionProviders entry (transformers.js
 * keeps a caller-provided EP via the `??=` seam). On CPU we omit it — no CUDA EP available.
 */
export function sessionOptions(): Record<string, unknown> {
  return {
    graphOptimizationLevel: "all",
    ...(env.EMBED_DEVICE === "cuda"
      ? { executionProviders: [{ name: "cuda", deviceId: env.EMBED_GPU_ID }] }
      : {}),
  };
}
