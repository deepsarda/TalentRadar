import { z } from "zod";

/*
 * Deterministic GitHub signals. They are facts, not judgments: the judge sees them as context and
 * the aggregation turns merged upstream pull requests into a small bounded bonus. Both reads are
 * best-effort: a failure leaves the signal out instead of failing the repository job.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Consistency is measured against at most this many weeks, so a long history is not punished. */
const CONSISTENCY_WINDOW_WEEKS = 26;

export interface CommitActivity {
  /** How many of the participant's commits were read (GitHub returns at most one page of 100). */
  commitsSampled: number;
  /** Distinct calendar weeks (Thursday-aligned epoch weeks) that contain a commit. */
  activeWeeks: number;
  /** Weeks from the first to the last sampled commit, inclusive. */
  spanWeeks: number;
  /** 0..1: active weeks over the span (capped at 26 weeks); 0 under two commits. */
  consistency: number;
}

/** Pure: how evenly a participant's commits are spread over time. */
export function commitConsistency(dates: readonly string[]): CommitActivity {
  const times = dates.map((date) => Date.parse(date)).filter((time) => Number.isFinite(time));
  if (times.length === 0)
    return { commitsSampled: 0, activeWeeks: 0, spanWeeks: 0, consistency: 0 };
  const weeks = times.map((time) => Math.floor(time / WEEK_MS));
  const activeWeeks = new Set(weeks).size;
  const spanWeeks = Math.max(...weeks) - Math.min(...weeks) + 1;
  const consistency =
    times.length < 2 ? 0 : Math.min(1, activeWeeks / Math.min(spanWeeks, CONSISTENCY_WINDOW_WEEKS));
  return {
    commitsSampled: times.length,
    activeWeeks,
    spanWeeks,
    consistency: Math.round(consistency * 100) / 100,
  };
}

const CommitListSchema = z.array(
  z.object({
    commit: z.object({ author: z.object({ date: z.string().nullish() }).nullish() }).nullish(),
  }),
);

async function json(
  url: string,
  token: string | undefined,
  fetchImplementation: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-github-api-version": "2026-03-10",
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok)
    throw new Error(`GitHub returned ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

/** Reads the participant's own recent commits in one repository (one request). */
export async function fetchCommitActivity(
  repository: string,
  login: string,
  token: string | undefined,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<CommitActivity | undefined> {
  try {
    const encoded = repository.split("/").map(encodeURIComponent).join("/");
    const payload = await json(
      `https://api.github.com/repos/${encoded}/commits?author=${encodeURIComponent(login)}&per_page=100`,
      token,
      fetchImplementation,
      signal,
    );
    const commits = CommitListSchema.parse(payload);
    return commitConsistency(
      commits.flatMap((entry) => (entry.commit?.author?.date ? [entry.commit.author.date] : [])),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

export interface UpstreamContributions {
  /** Merged pull requests this person authored in public repositories they do not own. */
  mergedUpstreamPullRequests: number;
}

const SearchSchema = z.object({ total_count: z.number().int().nonnegative() });

const upstreamCache = new Map<string, { at: number; value: UpstreamContributions }>();
/** One profile fetches several repositories; they share one search per person for a while. */
const UPSTREAM_CACHE_MS = 10 * 60_000;

/**
 * Counts merged PRs the person authored into other people's public repositories, using GitHub's
 * search API (its own, tighter rate limit applies; a refusal just leaves the signal out).
 * Memoised per login for ten minutes so a profile's repositories do not each repeat the search.
 */
export async function fetchUpstreamContributions(
  login: string,
  token: string | undefined,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<UpstreamContributions | undefined> {
  const key = login.toLowerCase();
  const cached = upstreamCache.get(key);
  if (cached && now - cached.at < UPSTREAM_CACHE_MS) return cached.value;
  try {
    const query = `author:${login} type:pr is:merged is:public -user:${login}`;
    const payload = await json(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
      token,
      fetchImplementation,
      signal,
    );
    const value = { mergedUpstreamPullRequests: SearchSchema.parse(payload).total_count };
    upstreamCache.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

/** Test hook: forget memoised searches. */
export function clearUpstreamCache(): void {
  upstreamCache.clear();
}
