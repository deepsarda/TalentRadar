import { readFile } from "node:fs/promises";
import { promptVersion, taxonomyIds } from "@talentradar/shared";
import { describe, expect, it } from "vitest";
import type { CvFacts, RepositoryFacts } from "./judge.js";
import { collectRepositories, judgeAndAggregate, prepareCv } from "./local-run.js";

/*
 * End-to-end validation against the real services: GitHub -> sampling -> CV render -> Gemini ->
 * aggregation, with the same functions the worker's job handlers call. Skipped unless
 *   GITHUB_TOKEN, GEMINI_API_KEY and E2E_GITHUB_LOGIN   are set; optionally
 *   E2E_CV_PDF   a path to a SYNTHETIC CV PDF (free-tier Gemini content is used to improve
 *                Google's products, so never a real person's CV). Needs poppler's pdftoppm.
 * Run with: pnpm run validate:e2e
 *
 * What it checks, stage by stage:
 *  1. Fetch: at most 6 repos are selected for the login, each either included or skipped with a
 *     reason; included repos carry a 40-hex commit SHA, an authorship share in 0..1 and a push date.
 *  2. Sampling: at most 20 files per repo, within the repoTokenBudget character budget (4 chars per
 *     token), none from node_modules/dist/build/vendor or lock/minified files, and every technology
 *     hint a taxonomy id.
 *  3. CV render (only with E2E_CV_PDF): 1-3 pages rendered to PNG (checked by PNG signature),
 *     links extracted as strings, the hidden-text scan returns a boolean.
 *  4. Gemini: one call succeeds with the full schema; the raw response keeps reasoning before
 *     verdict; after per-block validation every repo block names a sent repo and every evidence
 *     path was sent for that repo.
 *  5. Aggregation: every skill has evidence (or a CV claim), level and effective level in 0..5,
 *     effective <= level, and novelty is one of 0, 0.25, 1.
 */

const env = process.env;
const login = env["E2E_GITHUB_LOGIN"];
const githubToken = env["GITHUB_TOKEN"];
const geminiApiKey = env["GEMINI_API_KEY"];
const cvPath = env["E2E_CV_PDF"];
const model = env["GEMINI_MODEL"] ?? "gemini-3.1-flash-lite";
const repoTokenBudget = Number(env["REPO_TOKEN_BUDGET"] ?? 12_000);
const ready = Boolean(login && githubToken && geminiApiKey);
const log = (line: string) => console.log(line);

describe.skipIf(!ready)("end-to-end pipeline (live)", () => {
  let repositories: RepositoryFacts[] = [];
  let cv: CvFacts | undefined;
  let pages: string[] = [];

  it("1. fetches at most six repositories with real facts", async () => {
    repositories = await collectRepositories({
      login: login ?? "",
      githubToken: githubToken ?? "",
      repoTokenBudget,
      log,
    });
    expect(repositories.length).toBeLessThanOrEqual(6);
    expect(repositories.some((repository) => repository.included)).toBe(true);
    for (const repository of repositories) {
      if (!repository.included) continue;
      expect(repository.commitSha).toMatch(/^[a-f0-9]{40}$/);
      expect(repository.authorship).toBeGreaterThanOrEqual(0);
      expect(repository.authorship).toBeLessThanOrEqual(1);
      expect(Number.isNaN(Date.parse(repository.pushedAt))).toBe(false);
    }
  }, 600_000);

  it("2. samples within the per-repo budget and skips vendored or generated files", () => {
    const known = new Set<string>(taxonomyIds);
    for (const repository of repositories) {
      if (!repository.included) continue;
      const characters = repository.selectedFiles.reduce((sum, f) => sum + f.content.length, 0);
      expect(repository.selectedFiles.length).toBeLessThanOrEqual(20);
      expect(characters).toBeLessThanOrEqual(repoTokenBudget * 4);
      for (const file of repository.selectedFiles) {
        expect(file.path).not.toMatch(
          /(^|\/)(node_modules|dist|build|vendor)\/|\.min\.js$|\.lock$/,
        );
      }
      for (const hint of repository.technologyMatches) expect(known.has(hint.id)).toBe(true);
    }
  });

  it.skipIf(!cvPath)(
    "3. renders the synthetic CV and reads its links",
    async () => {
      ({ cv, pages } = await prepareCv(await readFile(cvPath ?? "")));
      expect(pages.length).toBeGreaterThanOrEqual(1);
      expect(pages.length).toBeLessThanOrEqual(3);
      for (const page of pages) {
        expect(Buffer.from(page, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      }
      expect(cv.links.every((link) => typeof link === "string")).toBe(true);
      expect(typeof cv.possiblePromptInjection).toBe("boolean");
    },
    120_000,
  );

  it("4-5. judges once with Gemini and aggregates an evidence-backed profile", async () => {
    const { judgment, profile, rawText } = await judgeAndAggregate({
      personId: login ?? "",
      displayName: login ?? "",
      geminiApiKey: geminiApiKey ?? "",
      model,
      repositories,
      ...(cv ? { cv, pages } : await prepareCv(undefined)),
    });
    log(`prompt ${promptVersion}, ${rawText.length} chars of raw output`);
    expect(rawText.indexOf('"thoughts"')).toBeLessThan(rawText.indexOf('"summary"'));

    const sent = new Map(
      repositories.flatMap((repository) =>
        repository.included
          ? [
              [
                repository.repository,
                new Set([
                  ...repository.selectedFiles.map((file) => file.path),
                  ...(repository.readmePath ? [repository.readmePath] : []),
                  ...repository.tree,
                  ...[
                    ...repository.tree,
                    ...repository.selectedFiles.map((file) => file.path),
                  ].flatMap((file) => {
                    const segments = file.split("/");
                    return segments
                      .slice(0, -1)
                      .map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);
                  }),
                ]),
              ] as const,
            ]
          : [],
      ),
    );
    for (const repository of judgment.repos) {
      const paths = sent.get(repository.repo);
      expect(paths, repository.repo).toBeDefined();
      for (const skill of repository.skills) {
        for (const item of skill.evidence) expect(paths?.has(item.path), item.path).toBe(true);
      }
    }

    expect([0, 0.25, 1]).toContain(profile.novelty);
    for (const skill of profile.skills) {
      expect(skill.level).toBeGreaterThanOrEqual(0);
      expect(skill.level).toBeLessThanOrEqual(5);
      expect(skill.effective).toBeLessThanOrEqual(skill.level);
      const claimed = judgment.cv.claims.some((claim) => claim.id === skill.id);
      expect(skill.evidence.length > 0 || claimed, skill.id).toBe(true);
    }
  }, 300_000);
});
