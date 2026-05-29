import type { Embedder } from "../../../embeddings/embedder";
import type { Reranker } from "../../../embeddings/reranker";
import type { Summarizer } from "../../../embeddings/summarizer";
import type { runChatTurn } from "../../../providers/claude-sdk";
import type { runChatCompletionTurn, runRawTurn } from "../../../providers/openrouter";

export interface ChatServiceDeps {
  runTurn?: typeof runChatTurn;
  runRaw?: typeof runRawTurn;
  runChatCompletion?: typeof runChatCompletionTurn;
  embedder?: Embedder;
  reranker?: Reranker;
  summarizer?: Summarizer;
}
