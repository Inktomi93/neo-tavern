import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";
import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { env } from "../env";

// In-process observability: structured pino logs that ALSO land in bounded ring
// buffers, so the /api/_debug API can serve "everything" over HTTP — no tailing.
// Doctrine (docs/observability.md): logs are METADATA; RP content lives in the DB.

const LOG_RING_CAPACITY = 2000;
const REQUEST_RING_CAPACITY = 500;

/** Circular buffer of raw serialized log lines. We store strings and parse lazily
 *  on query (cheap writes; the parse cost only happens when someone curls). */
class LineRing {
  private readonly buf: (string | undefined)[];
  private readonly cap: number;
  private head = 0;
  private size = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.buf = new Array<string | undefined>(cap);
  }

  push(line: string): void {
    this.buf[this.head] = line;
    this.head = (this.head + 1) % this.cap;
    this.size = Math.min(this.size + 1, this.cap);
  }

  /** Most-recent-first. */
  recent(limit: number): string[] {
    const out: string[] = [];
    const n = Math.min(limit, this.size);
    for (let i = 1; i <= n; i += 1) {
      const line = this.buf[(this.head - i + this.cap) % this.cap];
      if (line !== undefined) {
        out.push(line);
      }
    }
    return out;
  }
}

export interface RequestRecord {
  id: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  at: number;
}

class RequestRing {
  private readonly buf: (RequestRecord | undefined)[];
  private readonly cap: number;
  private head = 0;
  private size = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.buf = new Array<RequestRecord | undefined>(cap);
  }

  push(record: RequestRecord): void {
    this.buf[this.head] = record;
    this.head = (this.head + 1) % this.cap;
    this.size = Math.min(this.size + 1, this.cap);
  }

  recent(limit: number): RequestRecord[] {
    const out: RequestRecord[] = [];
    const n = Math.min(limit, this.size);
    for (let i = 1; i <= n; i += 1) {
      const record = this.buf[(this.head - i + this.cap) % this.cap];
      if (record !== undefined) {
        out.push(record);
      }
    }
    return out;
  }
}

export const logRing = new LineRing(LOG_RING_CAPACITY);
const requestRing = new RequestRing(REQUEST_RING_CAPACITY);

export function recordRequest(record: RequestRecord): void {
  requestRing.push(record);
}

export function recentRequests(limit: number): RequestRecord[] {
  return requestRing.recent(limit);
}

// A stream that captures each already-serialized JSON line into the ring. No
// parsing here — that's the whole point (cheap on the hot path).
const ringStream = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    logRing.push(chunk.toString("utf8").trimEnd());
    callback();
  },
});

export const logger: Logger = pino(
  {
    level: env.LOG_LEVEL,
    // Auth/secrets only — we never log RP bodies, so there's nothing else to scrub.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "authorization",
        "token",
        "apiKey",
        "password",
      ],
      censor: "[redacted]",
    },
  },
  pino.multistream([{ stream: process.stdout }, { stream: ringStream }]),
);

interface RequestContext {
  requestId: string;
  log: Logger;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with a request-scoped child logger bound to this request id. */
export function runInRequest<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId, log: logger.child({ requestId }) }, fn);
}

/** The current request's logger (carries requestId), or the base logger. */
export function getLog(): Logger {
  return requestContext.getStore()?.log ?? logger;
}
