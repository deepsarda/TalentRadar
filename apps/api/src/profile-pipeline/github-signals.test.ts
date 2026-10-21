import { beforeEach, describe, expect, it } from "vitest";
import {
  clearUpstreamCache,
  commitConsistency,
  fetchCommitActivity,
  fetchUpstreamContributions,
} from "./github-signals.js";
import { buildPrompt, FetchResultSchema, mergedUpstreamPullRequests, noCv } from "./judge.js";

const day = (offset: number) => new Date(Date.UTC(2026, 0, 5 + offset)).toISOString();

describe("commitConsistency", () => {
  it("is 0 with no commits or one commit", () => {
    expect(commitConsistency([])).toEqual({
      commitsSampled: 0,
      activeWeeks: 0,
      spanWeeks: 0,
      consistency: 0,
    });
    expect(commitConsistency([day(0)]).consistency).toBe(0);
  });

  it("is 1 for a commit every week and low for one burst plus one old commit", () => {
    const steady = commitConsistency([0, 7, 14, 21].map(day));
    expect(steady).toMatchObject({ activeWeeks: 4, spanWeeks: 4, consistency: 1 });
    const bursty = commitConsistency([day(0), day(1), day(2), day(3 * 7 * 8)]);
    expect(bursty.consistency).toBeLessThan(0.4);
  });

  it("caps the measuring window so long histories are not punished", () => {
    const weekly = Array.from({ length: 60 }, (_, index) => day(index * 7));
    expect(commitConsistency(weekly).consistency).toBe(1);
  });

  it("ignores unparseable dates", () => {
    expect(commitConsistency(["nope", day(0), day(7)]).commitsSampled).toBe(2);
  });
});

describe("GitHub signal reads", () => {
  beforeEach(clearUpstreamCache);

  it("reads the participant's commits for one repository", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return Response.json([
        { commit: { author: { date: day(0) } } },
        { commit: { author: { date: day(7) } } },
        { commit: null },
      ]);
    }) as typeof fetch;
    const result = await fetchCommitActivity("a/b", "riya", undefined, fakeFetch);
    expect(result).toMatchObject({ commitsSampled: 2, consistency: 1 });
    expect(urls[0]).toContain("/repos/a/b/commits?author=riya&per_page=100");
  });

  it("leaves the signal out instead of failing when GitHub refuses", async () => {
    const refuse = (async () => new Response("no", { status: 409 })) as typeof fetch;
    expect(await fetchCommitActivity("a/b", "riya", undefined, refuse)).toBeUndefined();
    expect(await fetchUpstreamContributions("riya", undefined, refuse)).toBeUndefined();
  });

  it("counts merged public PRs into other people's repositories, once per person", async () => {
    let calls = 0;
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      calls += 1;
      urls.push(decodeURIComponent(String(url)));
      return Response.json({ total_count: 7, items: [] });
    }) as typeof fetch;
    const first = await fetchUpstreamContributions("Riya", undefined, fakeFetch, undefined, 1000);
    const second = await fetchUpstreamContributions("riya", undefined, fakeFetch, undefined, 2000);
    expect(first).toEqual({ mergedUpstreamPullRequests: 7 });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(urls[0]).toContain("author:Riya type:pr is:merged is:public -user:Riya");
  });

  it("searches again once the memo expires", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return Response.json({ total_count: calls });
    }) as typeof fetch;
    await fetchUpstreamContributions("x", undefined, fakeFetch, undefined, 0);
    const later = await fetchUpstreamContributions(
      "x",
      undefined,
      fakeFetch,
      undefined,
      11 * 60_000,
    );
    expect(later).toEqual({ mergedUpstreamPullRequests: 2 });
  });
});

describe("signals in stored facts and the prompt", () => {
  const included = {
    repository: "a/b",
    included: true as const,
    commitSha: "a".repeat(40),
    pushedAt: "2026-09-01T00:00:00Z",
    authorship: 1,
    languages: { TypeScript: 10 },
    hasTests: true,
    hasCi: true,
    containerized: false,
    technologyMatches: [],
    tree: [],
    selectedFiles: [],
  };

  it("still parses fetch results stored before the signals existed", () => {
    expect(FetchResultSchema.safeParse(included).success).toBe(true);
    expect(mergedUpstreamPullRequests([FetchResultSchema.parse(included)])).toBeUndefined();
  });

  it("sends commit activity and the participant line only when present", () => {
    const plain = buildPrompt([FetchResultSchema.parse(included)], noCv, 0);
    expect(plain).not.toContain("mergedUpstreamPullRequests=");
    expect(plain).not.toContain('"commitActivity"');
    const withSignals = buildPrompt(
      [
        FetchResultSchema.parse({
          ...included,
          commitActivity: { commitsSampled: 5, activeWeeks: 3, spanWeeks: 4, consistency: 0.75 },
          participant: { mergedUpstreamPullRequests: 4 },
        }),
      ],
      noCv,
      0,
    );
    expect(withSignals).toContain("mergedUpstreamPullRequests=4");
    expect(withSignals).toContain('"commitActivity":{"commitsSampled":5');
  });

  it("takes the person-level count as the maximum across repositories", () => {
    const repo = (count: number) =>
      FetchResultSchema.parse({ ...included, participant: { mergedUpstreamPullRequests: count } });
    expect(mergedUpstreamPullRequests([repo(2), repo(5)])).toBe(5);
  });
});
