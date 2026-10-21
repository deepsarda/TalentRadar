import { describe, expect, it } from "vitest";
import {
  createGithubClient,
  geminiRetryLater,
  MongoWindowLimiter,
  parseRetryAfter,
  RetryLaterError,
  WindowLimiter,
} from "./rate-limit.js";

/** A clock that only moves when the limiter sleeps. */
function fakeClock(start = 1_000_000) {
  const clock = { now: start, slept: [] as number[] };
  return {
    clock,
    now: () => clock.now,
    sleep: async (milliseconds: number) => {
      clock.slept.push(milliseconds);
      clock.now += milliseconds;
    },
  };
}

function gemini(clock: ReturnType<typeof fakeClock>, maxWaitMs = 65_000) {
  return new WindowLimiter({
    name: "Gemini",
    windowMs: 60_000,
    maxRequests: 2,
    maxUnits: 100_000,
    maxWaitMs,
    now: clock.now,
    sleep: clock.sleep,
  });
}

describe("parseRetryAfter", () => {
  it("reads delay-seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("WindowLimiter", () => {
  it("caps requests per window", async () => {
    const clock = fakeClock();
    const limiter = gemini(clock);
    await limiter.acquire(1);
    await limiter.acquire(1);
    expect(clock.clock.slept).toEqual([]);
    await limiter.acquire(1);
    expect(clock.clock.slept).toEqual([60_000]);
  });

  it("caps tokens per window and reconciles the estimate with actual usage", async () => {
    const clock = fakeClock();
    const limiter = gemini(clock);
    const settle = await limiter.acquire(90_000);
    expect(limiter.waitMs(90_000)).toBe(60_000);
    settle(5_000); // the call used far less than estimated
    expect(limiter.waitMs(90_000)).toBe(0);
  });

  it("lets an over-budget request run alone in an empty window", async () => {
    const clock = fakeClock();
    const limiter = gemini(clock);
    expect(limiter.waitMs(150_000)).toBe(0);
    await limiter.acquire(150_000);
    expect(limiter.waitMs(150_000)).toBe(60_000);
  });

  it("reschedules instead of sleeping through a long pause", async () => {
    const clock = fakeClock();
    const limiter = gemini(clock, 10_000);
    limiter.pauseUntil(clock.now() + 120_000);
    const error = await limiter.acquire(1).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryLaterError);
    expect((error as RetryLaterError).retryAt.getTime()).toBe(clock.now() + 120_000);
    expect((error as RetryLaterError).countsAsAttempt).toBe(false);
  });
});

describe("geminiRetryLater", () => {
  it("uses RetryInfo's retryDelay on a 429 and pauses the limiter", () => {
    const clock = fakeClock();
    const limiter = gemini(clock);
    const apiError = Object.assign(
      new Error('{"error":{"code":429,"details":[{"retryDelay": "31s"}]}}'),
      { status: 429 },
    );
    const retry = geminiRetryLater(apiError, 1, limiter, clock.now());
    expect(retry?.retryAt.getTime()).toBe(clock.now() + 31_000);
    expect(retry?.countsAsAttempt).toBe(false);
    expect(limiter.waitMs()).toBe(31_000);
    expect(geminiRetryLater(new Error("bad json"), 1, limiter)).toBeUndefined();
  });
});

describe("GitHub client", () => {
  function github(responses: Response[], clock = fakeClock()) {
    const calls: string[] = [];
    const fetchImplementation = (async (input: string | URL | Request) => {
      calls.push(String(input));
      const response = responses.shift();
      if (!response) throw new Error("no more responses");
      return response;
    }) as typeof fetch;
    const client = createGithubClient({
      requestsPerHour: 5000,
      fetchImplementation,
      now: clock.now,
      sleep: clock.sleep,
    });
    return { client, calls, clock };
  }

  it("waits out a short Retry-After on 429 and retries", async () => {
    const { client, calls, clock } = github([
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      new Response("[]", { status: 200 }),
    ]);
    const response = await client("https://api.github.com/repos/a/b/languages");
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(clock.clock.slept).toEqual([2_000]);
  });

  it("reschedules the job when the quota resets far in the future, without another call", async () => {
    const clock = fakeClock();
    const resetSeconds = Math.floor(clock.now() / 1000) + 1800;
    const { client, calls } = github(
      [
        new Response("{}", {
          status: 200,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) },
        }),
      ],
      clock,
    );
    await client("https://api.github.com/repos/a/b/languages");
    const error = await client("https://api.github.com/repos/a/b/contributors").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RetryLaterError);
    expect((error as RetryLaterError).retryAt.getTime()).toBe(resetSeconds * 1000);
    expect(calls).toHaveLength(1);
  });

  it("keeps separate buckets per token", async () => {
    const clock = fakeClock();
    const resetSeconds = Math.floor(clock.now() / 1000) + 1800;
    const { client, calls } = github(
      [
        new Response("{}", {
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) },
        }),
        new Response("{}"),
      ],
      clock,
    );
    await client("https://api.github.com/a", { headers: { authorization: "Bearer one" } });
    await client("https://api.github.com/b", { headers: { authorization: "Bearer two" } });
    expect(calls).toHaveLength(2);
  });

  it("retries a 401 anonymously when the token was revoked", async () => {
    const authorizations: Array<string | null> = [];
    const responses = [new Response("", { status: 401 }), new Response("[]", { status: 200 })];
    const client = createGithubClient({
      requestsPerHour: 5000,
      fetchImplementation: (async (_input: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return responses.shift() ?? new Response("", { status: 500 });
      }) as typeof fetch,
    });
    const response = await client("https://api.github.com/users/wesbos/repos", {
      headers: { authorization: "Bearer revoked" },
    });
    expect(response.status).toBe(200);
    expect(authorizations).toEqual(["Bearer revoked", null]);
  });

  it("keeps the 401 when the anonymous retry also fails", async () => {
    const { client, calls } = github([
      new Response("", { status: 401 }),
      new Response("", { status: 404 }),
    ]);
    const response = await client("https://api.github.com/user/repos", {
      headers: { authorization: "Bearer revoked" },
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 401 that had no token", async () => {
    const { client, calls } = github([new Response("", { status: 401 })]);
    const response = await client("https://api.github.com/a");
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("counts a long 503 as a failed attempt", async () => {
    const { client } = github([
      new Response("", { status: 503, headers: { "retry-after": "120" } }),
    ]);
    const error = await client("https://api.github.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryLaterError);
    expect((error as RetryLaterError).countsAsAttempt).toBe(true);
  });

  describe("MongoWindowLimiter (simulated workers)", () => {
    it("shares rate limit state across two simulated workers", async () => {
      // In-memory fake Mongo collection supporting findOneAndUpdate, updateOne
      const storage = new Map<string, any>();
      const fakeDb: any = {
        collection: () => ({
          findOneAndUpdate: async (filter: any, update: any, options: any) => {
            let doc = storage.get(filter._id);
            if (!doc && options.upsert) {
              doc = { _id: filter._id, entries: [], updatedAt: new Date() };
              storage.set(filter._id, doc);
            }
            if (update.$pull?.entries?.at?.$lte !== undefined) {
              const cutoff = update.$pull.entries.at.$lte;
              doc.entries = doc.entries.filter((e: any) => e.at > cutoff);
            }
            return doc;
          },
          updateOne: async (filter: any, update: any) => {
            const doc = storage.get(filter._id);
            if (doc && update.$push?.entries) {
              doc.entries.push(update.$push.entries);
            }
            if (doc && update.$set) {
              Object.assign(doc, update.$set);
            }
          },
        }),
      };

      const clock = fakeClock();
      const worker1 = new MongoWindowLimiter({
        name: "test-shared",
        db: fakeDb,
        windowMs: 60_000,
        maxRequests: 2,
        maxWaitMs: 120_000,
        now: clock.now,
        sleep: clock.sleep,
      });

      const worker2 = new MongoWindowLimiter({
        name: "test-shared",
        db: fakeDb,
        windowMs: 60_000,
        maxRequests: 2,
        maxWaitMs: 120_000,
        now: clock.now,
        sleep: clock.sleep,
      });

      // Worker 1 acquires 1 request
      await worker1.acquire(1);
      // Worker 2 acquires 1 request
      await worker2.acquire(1);
      expect(clock.clock.slept).toEqual([]);

      // 3rd request from Worker 1 must wait because window capacity (2) is exhausted
      await worker1.acquire(1);
      expect(clock.clock.slept).toEqual([60_000]);
    });
  });
});
