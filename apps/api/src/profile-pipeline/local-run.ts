import { GoogleGenAI } from "@google/genai";
import { aggregateProfile, type PersonProfile, type ProfileJudgment } from "@talentradar/shared";
import { z } from "zod";
import { githubFetch } from "../jobs/rate-limit.js";
import { selectRecentRepositories } from "../quick/import-row.js";
import { inspectCvPdf, renderPdfPages } from "./cv.js";
import {
  type CvFacts,
  FetchResultSchema,
  judgeProfile,
  noCv,
  type RepositoryFacts,
} from "./judge.js";
import { fetchRepository } from "./repository.js";

/*
 * The four pipeline stages for one person without MongoDB or the job queue, for the diagnostic
 * CLIs, the calibration runner and the end-to-end check. Each stage calls the same functions the
 * worker's job handlers call, so what these tools show is what production does.
 */

export type Log = (line: string) => void;

const GithubRepositorySchema = z.object({
  full_name: z.string(),
  fork: z.boolean(),
  pushed_at: z.iso.datetime({ offset: true }).nullable(),
});

const progressTo = (log: Log) => async (_code: string, message: string) => log(`  ${message}`);

/** Stages 1-2 for a login: the spec's six most recent eligible repositories, cloned and extracted. */
export async function collectRepositories(options: {
  login: string;
  githubToken: string | undefined;
  repoTokenBudget: number;
  log: Log;
  signal?: AbortSignal;
}): Promise<RepositoryFacts[]> {
  const selected = await selectRecentRepositories(options.login, options.githubToken, githubFetch);
  options.log(`Selected ${selected.length} repositories for @${options.login}`);
  const repositories: RepositoryFacts[] = [];
  // Sequential on purpose: one clone at a time, like the worker at concurrency one.
  for (const repository of selected) {
    repositories.push(
      FetchResultSchema.parse(
        await fetchRepository({
          repository: repository.fullName,
          login: options.login,
          token: options.githubToken,
          pushedAt: repository.pushedAt,
          fork: repository.fork,
          repoTokenBudget: options.repoTokenBudget,
          signal: options.signal,
          progress: progressTo(options.log),
        }),
      ),
    );
  }
  return repositories;
}

/** Stages 1-2 for one named repository (calibration), credited to its owner. */
export async function collectRepository(options: {
  repository: string;
  githubToken: string;
  repoTokenBudget: number;
  log: Log;
  signal?: AbortSignal;
}): Promise<RepositoryFacts> {
  const encoded = options.repository.split("/").map(encodeURIComponent).join("/");
  const response = await githubFetch(`https://api.github.com/repos/${encoded}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${options.githubToken}`,
      "x-github-api-version": "2026-03-10",
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${options.repository}`);
  const metadata = GithubRepositorySchema.parse(await response.json());
  if (!metadata.pushed_at) throw new Error(`${options.repository} has never been pushed`);
  return FetchResultSchema.parse(
    await fetchRepository({
      repository: metadata.full_name,
      login: metadata.full_name.split("/")[0] ?? "",
      token: options.githubToken,
      pushedAt: metadata.pushed_at,
      fork: metadata.fork,
      repoTokenBudget: options.repoTokenBudget,
      signal: options.signal,
      progress: progressTo(options.log),
    }),
  );
}

/** The CV half of stage 1 for a local PDF: links, hidden-text scan and rendered pages. */
export async function prepareCv(
  pdf: Buffer | undefined,
  signal?: AbortSignal,
): Promise<{ cv: CvFacts; pages: string[] }> {
  if (!pdf) return { cv: noCv, pages: [] };
  const inspection = await inspectCvPdf(pdf);
  const pages = await renderPdfPages(pdf, signal);
  return {
    cv: {
      fileId: "local",
      pageCount: inspection.pageCount,
      renderedPageCount: pages.length,
      links: inspection.links,
      possiblePromptInjection: inspection.possiblePromptInjection,
    },
    pages,
  };
}

/** Stages 3-4: one Gemini call, per-block validation, then aggregation. */
export async function judgeAndAggregate(options: {
  personId: string;
  displayName: string;
  geminiApiKey: string;
  model: string;
  repositories: RepositoryFacts[];
  cv: CvFacts;
  pages: string[];
  signal?: AbortSignal;
}): Promise<{ judgment: ProfileJudgment; profile: PersonProfile; rawText: string }> {
  const { result, rawText } = await judgeProfile({
    ai: new GoogleGenAI({ apiKey: options.geminiApiKey }),
    model: options.model,
    repositories: options.repositories,
    cv: options.cv,
    pages: options.pages,
    attempt: 1,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    judgment: result,
    profile: aggregateProfile(options.personId, options.displayName, result),
    rawText,
  };
}
