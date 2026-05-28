import {
  env as hf,
  type ImageFeatureExtractionPipeline,
  pipeline,
} from "@huggingface/transformers";
import { env } from "../env";
import { WarmModel } from "./warm-model";

hf.cacheDir = env.MODEL_CACHE_DIR;

export const IMAGE_EMBEDDING_MODEL = "onnx-community/siglip2-so400m-patch14-384-ONNX";

export interface ImageEmbedder {
  readonly model: string;
  embed(imageInput: unknown): Promise<Float32Array>;
}

function sessionOptions(): Record<string, unknown> {
  return {
    graphOptimizationLevel: "all",
    ...(env.EMBED_DEVICE === "cuda"
      ? { executionProviders: [{ name: "cuda", deviceId: env.EMBED_GPU_ID }] }
      : {}),
  };
}

const warm = new WarmModel<ImageFeatureExtractionPipeline>({
  name: `${IMAGE_EMBEDDING_MODEL}@${env.EMBED_DEVICE}:${env.EMBED_GPU_ID}`,
  idleMs: env.IDLE_UNLOAD_MIN * 60_000,
  load: () =>
    pipeline("image-feature-extraction", IMAGE_EMBEDDING_MODEL, {
      device: env.EMBED_DEVICE as "cpu" | "cuda",
      dtype: env.EMBED_DTYPE as "fp32" | "fp16",
      session_options: sessionOptions(),
    }),
  unload: (extractor) => extractor.dispose(),
  warm: async (extract) => {
    // Note: WarmUp requires a real 1x1 image or data URI to avoid crashing the pipeline.
    // We create a tiny 1x1 transparent PNG data URI for the warm up pass.
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await extract(tinyPng);
  },
});

export function warmUpImageEmbedder(): Promise<void> {
  return warm.warmUp();
}

export function createImageEmbedder(): ImageEmbedder {
  return {
    model: IMAGE_EMBEDDING_MODEL,
    embed(imageInput: unknown): Promise<Float32Array> {
      return warm.use(async (extractor) => {
        // biome-ignore lint/suspicious/noExplicitAny: dynamic huggingface input
        const output = await extractor(imageInput as any);
        // SigLIP-2 returns the dense embedding
        return output.data as Float32Array;
      });
    },
  };
}
