import { createHash } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";
import type { Db } from "mongodb";
import { readEnvironment } from "../config/environment.js";
import { collections } from "../database/mongo.js";
import { backoffMs } from "./queue.js";

/*
 * Outbound rate limiting for the worker: Gemini by requests AND tokens per minute, GitHub by
 * requests per hour (per token, corrected by GitHub's own X-RateLimit headers).
 *
 * Ceiling: all limiter state is per process. That is right for the free deployment (one worker,
 * concurrency one). If the worker is ever scaled out, the windows must move to a shared
 * Mongo-backed bucket (one document per limiter, updated with an atomic findOneAndUpdate), or
 * each process will spend the whole quota on its own.
 */

/** Thrown when a job should run again later instead of holding its lease while it waits. */
export class RetryLaterError extends Error {
  readonly retryAt: Date;
  /** Rate-limit waits do not use up an attempt; server errors (503) do. */
  readonly countsAsAttempt: boolean;

  constructor(message: string, retryAt: Date, options: { countsAsAttempt?: boolean } = {}) {
    super(message);
    this.name = "RetryLaterError";
    this.retryAt = retryAt;
    this.countsAsAttempt = options.countsAsAttempt ?? false;
  }
}

/** Parses a Retry-After header (delay-seconds or an HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export interface WindowLimiterOptions {
  name: string;
  windowMs: number;
  maxRequests: number;
  /** Optional second budget per window, e.g. tokens per minute. */
  maxUnits?: number;
  /** Waits longer than this throw RetryLaterError instead of sleeping inside the job lease. */
  maxWaitMs: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** Settles a permit with the real cost once it is known (e.g. usageMetadata.totalTokenCount). */
export type Settle = (actualUnits: number) => void;

/** A sliding-window limiter over requests and, optionally, units (tokens) per window. */
export class WindowLimiter {
  private readonly entries: Array<{ at: number; units: number }> = [];
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: WindowLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((milliseconds, signal) => sleepFor(milliseconds, undefined, { signal }));
  }

  /** Milliseconds until a request costing `units` fits; 0 means it fits now. */
  waitMs(units = 0): number {
    const now = this.now();
    while (this.entries[0] && this.entries[0].at <= now - this.options.windowMs) {
      this.entries.shift();
    }
    const expiresIn = (index: number) =>
      (this.entries[index]?.at ?? now) + this.options.windowMs - now;
    let wait = Math.max(0, this.pausedUntil - now);
    const { maxRequests, maxUnits } = this.options;
    if (this.entries.length >= maxRequests) {
      wait = Math.max(wait, expiresIn(this.entries.length - maxRequests));
    }
    if (maxUnits !== undefined && units > 0 && this.entries.length > 0) {
      let used = this.entries.reduce((sum, entry) => sum + entry.units, 0);
      // Find the oldest entry whose expiry frees enough units. A request larger than the whole
      // budget waits for an empty window and then goes alone rather than never running.
      let index = 0;
      while (index < this.entries.length && used + units > maxUnits) {
        used -= this.entries[index]?.units ?? 0;
        index += 1;
      }
      if (index > 0) wait = Math.max(wait, expiresIn(index - 1));
    }
    return wait;
  }

  /**
   * Waits for room for one request costing `estimatedUnits`, records it, and returns `settle`
   * to replace the estimate with the actual cost. Throws RetryLaterError when the wait exceeds
   * `maxWaitMs`, so the worker reschedules the job instead of sleeping on its lease.
   */
  async acquire(estimatedUnits = 0, signal?: AbortSignal): Promise<Settle> {
    for (;;) {
      const wait = this.waitMs(estimatedUnits);
      if (wait === 0) break;
      if (wait > this.options.maxWaitMs) {
        throw new RetryLaterError(
          `${this.options.name} rate limit reached; retrying later`,
          new Date(this.now() + wait),
        );
      }
      await this.sleep(wait, signal);
    }
    const entry = { at: this.now(), units: Math.max(0, estimatedUnits) };
    this.entries.push(entry);
    return (actualUnits) => {
      entry.units = Math.max(0, actualUnits);
    };
  }

  /** Blocks every acquire until `at` (epoch ms), e.g. after a 429 or an exhausted quota. */
  pauseUntil(at: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, at);
  }
}

export interface LimiterDocument {
  _id: string; // limiter name / key
  entries: Array<{ at: number; units: number }>;
  pausedUntil?: number;
  updatedAt: Date;
}

export interface MongoWindowLimiterOptions extends WindowLimiterOptions {
  db: Db;
}

/**
 * Shared Mongo-backed sliding-window rate limiter using atomic findOneAndUpdate.
 * Allows multiple worker processes to safely share token and request budgets.
 */
export class MongoWindowLimiter {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: MongoWindowLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((milliseconds, signal) => sleepFor(milliseconds, undefined, { signal }));
  }

  async acquire(estimatedUnits = 0, signal?: AbortSignal): Promise<Settle> {
    const col = this.options.db.collection<LimiterDocument>(collections.rateLimits);
    const key = this.options.name;

    for (;;) {
      const now = this.now();
      const cutoff = now - this.options.windowMs;

      // Atomic find and clean expired entries
      const doc = await col.findOneAndUpdate(
        { _id: key },
        {
          $pull: { entries: { at: { $lte: cutoff } } },
          $setOnInsert: { _id: key, updatedAt: new Date(now) },
        },
        { upsert: true, returnDocument: "after" },
      );

      const entries = doc?.entries ?? [];
      const pausedUntil = doc?.pausedUntil ?? 0;

      let wait = Math.max(0, pausedUntil - now);
      const { maxRequests, maxUnits } = this.options;

      if (entries.length >= maxRequests) {
        const oldestBlocking = entries[entries.length - maxRequests];
        if (oldestBlocking) {
          wait = Math.max(wait, oldestBlocking.at + this.options.windowMs - now);
        }
      }

      if (maxUnits !== undefined && estimatedUnits > 0 && entries.length > 0) {
        let used = entries.reduce((sum, e) => sum + e.units, 0);
        let idx = 0;
        while (idx < entries.length && used + estimatedUnits > maxUnits) {
          used -= entries[idx]?.units ?? 0;
          idx++;
        }
        if (idx > 0 && entries[idx - 1]) {
          wait = Math.max(wait, entries[idx - 1]!.at + this.options.windowMs - now);
        }
      }

      if (wait === 0) {
        const entryId = Math.random().toString(36).slice(2);
        const addedAt = this.now();
        await col.updateOne(
          { _id: key },
          {
            $push: {
              entries: {
                at: addedAt,
                units: Math.max(0, estimatedUnits),
                id: entryId,
              } as unknown as { at: number; units: number },
            },
            $set: { updatedAt: new Date(addedAt) },
          },
        );

        return (actualUnits: number) => {
          void col.updateOne(
            { _id: key, "entries.id": entryId },
            { $set: { "entries.$.units": Math.max(0, actualUnits) } },
          );
        };
      }

      if (wait > this.options.maxWaitMs) {
        throw new RetryLaterError(
          `${this.options.name} rate limit reached; retrying later`,
          new Date(now + wait),
        );
      }

      await this.sleep(wait, signal);
    }
  }

  async pauseUntil(at: number): Promise<void> {
    const col = this.options.db.collection<LimiterDocument>(collections.rateLimits);
    await col.updateOne(
      { _id: this.options.name },
      { $max: { pausedUntil: at }, $set: { updatedAt: new Date(this.now()) } },
      { upsert: true },
    );
  }
}

const environment = readEnvironment();

/**
 * Process-wide Gemini limiter (requests and tokens per minute).
 *
 *   const settle = await geminiLimiter.acquire(estimatedTokens, signal);
 *   try {
 *     const response = await ai.models.generateContent(...);
 *     settle(response.usageMetadata?.totalTokenCount ?? estimatedTokens);
 *   } catch (error) {
 *     throw geminiRetryLater(error, job.attempts) ?? error;
 *   }
 */
export const geminiLimiter = new WindowLimiter({
  name: "Gemini",
  windowMs: 60_000,
  maxRequests: environment.GEMINI_REQUESTS_PER_MINUTE,
  maxUnits: environment.GEMINI_TOKENS_PER_MINUTE,
  // A full minute window fits inside a lease because the worker renews it while we wait.
  maxWaitMs: 65_000,
});

/**
 * Turns a Gemini 429/503 (the SDK's ApiError has `status` and the JSON body in `message`,
 * including RetryInfo's `"retryDelay": "31s"`) into a RetryLaterError, and pauses the limiter
 * on a 429 so nothing else hammers the quota meanwhile. Returns undefined for other errors.
 */
export function geminiRetryLater(
  error: unknown,
  attempt: number,
  limiter: WindowLimiter = geminiLimiter,
  now = Date.now(),
): RetryLaterError | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : "";
  const isNetworkFailure =
    message.includes("fetch failed") ||
    message.includes("SocketError") ||
    message.includes("UND_ERR_SOCKET") ||
    message.includes("other side closed") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT");

  if (status !== 429 && status !== 503 && !isNetworkFailure) return undefined;

  const retryDelay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message)?.[1];
  const wait = retryDelay
    ? Math.ceil(Number(retryDelay) * 1000)
    : backoffMs(attempt, { baseMs: 5_000, capMs: 10 * 60_000 });
  if (status === 429) limiter.pauseUntil(now + wait);
  return new RetryLaterError(
    status === 429
      ? "Gemini rate limited; retrying later"
      : isNetworkFailure
        ? "Gemini connection reset; retrying shortly"
        : "Gemini unavailable; retrying later",
    new Date(now + wait),
    { countsAsAttempt: status === 503 || isNetworkFailure },
  );
}

export interface GithubClientOptions {
  requestsPerHour: number;
  fetchImplementation?: typeof fetch;
  /** Server-requested waits up to this long are slept through; longer ones reschedule. */
  maxInlineWaitMs?: number;
  maxTries?: number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Returns a drop-in `fetch` for GitHub's REST API. GitHub limits are per token, so each
 * Authorization header (hashed; anonymous calls share one bucket) gets its own hourly window,
 * paused until X-RateLimit-Reset whenever GitHub reports none remaining. 429s and rate-limit
 * 403s honour Retry-After (else the reset time); 503s honour Retry-After (else backoff). Short
 * waits are slept through; long ones throw RetryLaterError so the job is rescheduled.
 */
export function createGithubClient(options: GithubClientOptions): typeof fetch {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((milliseconds, signal) => sleepFor(milliseconds, undefined, { signal }));
  const maxInlineWaitMs = options.maxInlineWaitMs ?? 30_000;
  const maxTries = options.maxTries ?? 3;
  const limiters = new Map<string, WindowLimiter>();

  const limiterFor = (authorization: string | null) => {
    const key = authorization
      ? createHash("sha256").update(authorization).digest("hex")
      : "anonymous";
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = new WindowLimiter({
        name: "GitHub",
        windowMs: 60 * 60_000,
        maxRequests: options.requestsPerHour,
        maxWaitMs: maxInlineWaitMs,
        now,
        sleep,
      });
      limiters.set(key, limiter);
    }
    return limiter;
  };

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    const limiter = limiterFor(new Headers(init?.headers).get("authorization"));
    const pathname = new URL(input instanceof Request ? input.url : input).pathname;
    for (let attempt = 1; ; attempt += 1) {
      await limiter.acquire(0, signal);
      const response = await fetchImplementation(input, init);
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const resetWait = Number.isFinite(reset) && reset > 0 ? reset * 1000 - now() : undefined;
      if (remaining === "0" && resetWait !== undefined) limiter.pauseUntil(now() + resetWait);

      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && (remaining === "0" || retryAfter !== undefined));
      if (!rateLimited && response.status !== 503) return response;

      const wait =
        retryAfter ??
        (rateLimited && resetWait !== undefined && resetWait > 0
          ? resetWait
          : backoffMs(attempt, { baseMs: 1_000, capMs: 10 * 60_000 }));
      if (rateLimited) limiter.pauseUntil(now() + wait);
      if (wait <= maxInlineWaitMs && attempt < maxTries) {
        // A rate-limit pause is slept through by the next acquire; a 503 waits here.
        if (!rateLimited) await sleep(wait, signal);
        continue;
      }
      throw new RetryLaterError(
        rateLimited
          ? `GitHub rate limited ${pathname}; retrying later`
          : `GitHub returned ${response.status} for ${pathname}; retrying later`,
        new Date(now() + wait),
        { countsAsAttempt: !rateLimited },
      );
    }
  };
}

/** Process-wide rate-limited fetch for every GitHub REST call the worker makes. */
export const githubFetch = createGithubClient({
  requestsPerHour: environment.GITHUB_REQUESTS_PER_HOUR,
});
