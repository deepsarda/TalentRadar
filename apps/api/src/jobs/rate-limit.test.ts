import { describe, expect, it } from "vitest";
import {
  createGithubClient,
  geminiRetryLater,
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

  it("counts a long 503 as a failed attempt", async () => {
    const { client } = github([
      new Response("", { status: 503, headers: { "retry-after": "120" } }),
    ]);
    const error = await client("https://api.github.com/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetryLaterError);
    expect((error as RetryLaterError).countsAsAttempt).toBe(true);
  });
});
