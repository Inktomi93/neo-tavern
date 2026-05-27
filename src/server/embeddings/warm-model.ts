import { getLog } from "../observability/logger";

/**
 * A lazily-loaded model that stays WARM and frees its VRAM after an idle period — the shared
 * lifecycle behind the embedder and reranker (and a future local summarizer).
 *
 * Why this exists:
 *  - **Warm on boot** (`warmUp()`): load + JIT the kernels once so the first real request is fast.
 *  - **Idle-unload**: the A6000s are shared with other homelab services, so a model that hasn't been
 *    used in `idleMs` is disposed to give the VRAM back; the next request cold-reloads transparently.
 *  - **Failure-reset**: a *failed* load doesn't get cached forever (the classic lazy-singleton bug);
 *    the next call retries instead of the model being dead until a process restart.
 *  - **Concurrency-safe**: one shared instance serves all callers (transformers.js issues
 *    `session.run` directly on Node and ORT's Run is thread-safe). Eviction never fires mid-inference
 *    (`inFlight` guard) and never mid-load (`resolved` guard). No bounded queue — a single forward is
 *    light and multi-user isn't implemented yet; add bounds when real concurrent load is measured.
 */
export interface WarmModelOptions<T> {
  /** Label for logs (e.g. "bge-m3@cuda:0"). */
  name: string;
  /** Load (and GPU-place) the model. */
  load: () => Promise<T>;
  /** Free the model's resources/VRAM. */
  unload: (instance: T) => Promise<void>;
  /** Optional: run a representative dummy inference to JIT ORT's kernels at the real call shape. */
  warm?: (instance: T) => Promise<void>;
  /** Idle timeout in ms before unloading. 0 disables idle-unload (the model stays warm forever). */
  idleMs: number;
}

export class WarmModel<T> {
  private instance: Promise<T> | null = null;
  /** The resolved value, needed to call unload() — only set once load() succeeds. */
  private resolved: T | null = null;
  private lastUsedAt = 0;
  private inFlight = 0;

  private readonly opts: WarmModelOptions<T>;

  constructor(opts: WarmModelOptions<T>) {
    this.opts = opts;
    if (opts.idleMs > 0) {
      // Sweep at half the idle window, clamped to [10s, 60s]. unref() so it never holds the
      // process (or a test runner) open on its own.
      const periodMs = Math.min(60_000, Math.max(10_000, Math.floor(opts.idleMs / 2)));
      const timer = setInterval(() => void this.maybeEvict(), periodMs);
      timer.unref?.();
    }
  }

  /** Lazily load the model, caching the promise. On failure, clears the cache so a retry can reload. */
  private get(): Promise<T> {
    if (!this.instance) {
      getLog().info({ model: this.opts.name }, "warm-model: loading");
      this.instance = this.opts
        .load()
        .then((inst) => {
          this.resolved = inst;
          return inst;
        })
        .catch((error: unknown) => {
          this.instance = null;
          this.resolved = null;
          throw error;
        });
    }
    return this.instance;
  }

  /** Run `fn` against the (loaded) model, guarding it from idle-eviction for the duration. */
  async use<R>(fn: (instance: T) => Promise<R>): Promise<R> {
    this.inFlight += 1;
    this.lastUsedAt = Date.now();
    try {
      const instance = await this.get();
      return await fn(instance);
    } finally {
      this.inFlight -= 1;
      this.lastUsedAt = Date.now();
    }
  }

  /** Eagerly load + JIT kernels so the first real request is fast. Idempotent; call at boot. */
  async warmUp(): Promise<void> {
    const instance = await this.get();
    if (this.opts.warm) await this.opts.warm(instance);
    this.lastUsedAt = Date.now();
    getLog().info({ model: this.opts.name }, "warm-model: warmed up");
  }

  private async maybeEvict(): Promise<void> {
    // Nothing loaded, a load still in flight, an inference in progress, or not idle long enough.
    if (this.instance === null || this.resolved === null) return;
    if (this.inFlight > 0) return;
    if (Date.now() - this.lastUsedAt < this.opts.idleMs) return;

    // Detach synchronously (before any await) so a concurrent use() reloads a fresh instance.
    const instance = this.resolved;
    this.instance = null;
    this.resolved = null;
    try {
      await this.opts.unload(instance);
      getLog().info({ model: this.opts.name }, "warm-model: idle-unloaded (VRAM freed)");
    } catch (error) {
      getLog().warn(
        {
          model: this.opts.name,
          err: error instanceof Error ? error.message : JSON.stringify(error),
        },
        "warm-model: unload failed",
      );
    }
  }
}
