import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  env as hf,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor,
  RawImage,
} from "@huggingface/transformers";
import { getAppConfig } from "../config/app-config";
import { env } from "../env";
import { getLog } from "../observability/logger";
import { sessionOptions } from "./session-options";
import { WarmModel } from "./warm-model";

hf.cacheDir = env.MODEL_CACHE_DIR;
hf.allowRemoteModels = true;

export const IMAGE_EMBEDDING_MODEL = "onnx-community/siglip2-so400m-patch14-384-ONNX";

export interface ImageEmbedder {
  readonly model: string;
  embed(imageInput: unknown): Promise<Float32Array>;
  embedText(text: string): Promise<Float32Array>;
}

interface ImageModelBundle {
  model: PreTrainedModel;
  processor: Processor;
  tokenizer: PreTrainedTokenizer;
}

// We load the COMBINED SigLIP graph (one model.onnx with both towers). Its forward requires BOTH the
// image AND text inputs on every run, even when we only read one tower's output — so the image path
// feeds a fixed dummy text and the text path feeds a blank image. That's safe: image_embeds depend only
// on pixels and text_embeds only on tokens, so the unused tower's input never affects what we read.
const VISION_RES = 384; // siglip2-so400m-patch14-384
const SIGLIP_MAX_TOKENS = 64; // SigLIP's text tower was trained with FIXED 64-token padding…

// …and WITHOUT that exact padding the text embedding is misaligned with the image space, giving ~0
// cross-modal cosine (random retrieval — the bug that made text→image search return the placeholder).
function tokenizeSiglip(tokenizer: PreTrainedTokenizer, text: string) {
  return tokenizer(text, {
    padding: "max_length",
    max_length: SIGLIP_MAX_TOKENS,
    truncation: true,
  });
}
function blankImage(): RawImage {
  return new RawImage(
    new Uint8ClampedArray(VISION_RES * VISION_RES * 3),
    VISION_RES,
    VISION_RES,
    3,
  );
}

const warmModel = new WarmModel<ImageModelBundle>({
  name: `${IMAGE_EMBEDDING_MODEL}@${env.EMBED_DEVICE}:${env.EMBED_GPU_ID}`,
  idleMs: getAppConfig().idleUnloadMin * 60_000,
  load: async () => {
    const model = await AutoModel.from_pretrained(IMAGE_EMBEDDING_MODEL, {
      device: env.EMBED_DEVICE as "cpu" | "cuda",
      dtype: "fp32",
      session_options: sessionOptions(),
    });
    const processor = await AutoProcessor.from_pretrained(IMAGE_EMBEDDING_MODEL);
    const tokenizer = await AutoTokenizer.from_pretrained(IMAGE_EMBEDDING_MODEL);
    return { model, processor, tokenizer };
  },
  unload: async ({ model }) => {
    await model.dispose();
  },
  warm: async ({ model, processor, tokenizer }) => {
    const model_inputs = await processor(blankImage());
    const text_inputs = tokenizeSiglip(tokenizer, "warmup");
    model_inputs.input_ids = text_inputs.input_ids;
    model_inputs.attention_mask = text_inputs.attention_mask;
    await model(model_inputs);
  },
});

export async function warmUpImageEmbedder(): Promise<void> {
  await warmModel.warmUp();
}

function normalize(arr: Float32Array): Float32Array {
  let mag = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] ?? 0;
    mag += v * v;
  }
  mag = Math.sqrt(mag);
  if (mag === 0) return arr;
  for (let i = 0; i < arr.length; i++) {
    arr[i] = (arr[i] ?? 0) / mag;
  }
  return arr;
}

export function createImageEmbedder(): ImageEmbedder {
  return {
    model: IMAGE_EMBEDDING_MODEL,
    embed(imageInput: unknown): Promise<Float32Array> {
      return warmModel.use(async ({ model, processor, tokenizer }) => {
        const start = performance.now();
        let img = imageInput;
        if (typeof imageInput === "string") {
          const buffer = readFileSync(imageInput);
          const blob = new Blob([buffer]);
          img = await RawImage.read(blob);
        }
        const model_inputs = await processor(img);
        // image_embeds depend only on pixels; the text input is a required-but-ignored dummy.
        const text_inputs = tokenizeSiglip(tokenizer, "");
        model_inputs.input_ids = text_inputs.input_ids;
        model_inputs.attention_mask = text_inputs.attention_mask;

        const out = await model(model_inputs);
        const image_embeds = out.image_embeds.data as Float32Array;
        const normalized = normalize(new Float32Array(image_embeds));

        const durationMs = Math.round(performance.now() - start);
        getLog().debug(
          { model: IMAGE_EMBEDDING_MODEL, durationMs },
          "image-embedder: generated embedding",
        );
        return normalized;
      });
    },
    embedText(text: string): Promise<Float32Array> {
      return warmModel.use(async ({ model, processor, tokenizer }) => {
        const start = performance.now();
        // text_embeds depend only on tokens; the image is a required-but-ignored blank.
        const model_inputs = await processor(blankImage());
        const text_inputs = tokenizeSiglip(tokenizer, text);
        model_inputs.input_ids = text_inputs.input_ids;
        model_inputs.attention_mask = text_inputs.attention_mask;

        const out = await model(model_inputs);
        const text_embeds = out.text_embeds.data as Float32Array;
        const normalized = normalize(new Float32Array(text_embeds));

        const durationMs = Math.round(performance.now() - start);
        getLog().debug(
          { model: IMAGE_EMBEDDING_MODEL, durationMs },
          "image-embedder: generated text embedding",
        );
        return normalized;
      });
    },
  };
}
