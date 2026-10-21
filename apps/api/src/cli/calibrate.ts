import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { promptVersion, rubricVersion, samplerVersion, taxonomyVersion } from "@talentradar/shared";
import { readEnvironment } from "../config/environment.js";
import { RetryLaterError } from "../jobs/rate-limit.js";
import {
  CalibrationSetSchema,
  compositionWarnings,
  type EntryScore,
  scoreEntry,
  summarize,
} from "../profile-pipeline/calibration/calibration.js";
import { buildResults, type ScoredRepository } from "../profile-pipeline/calibration/report.js";
import { noCv } from "../profile-pipeline/judge.js";
import { collectRepository, judgeAndAggregate, type Log } from "../profile-pipeline/local-run.js";
import { currentVersions, resolveFiles } from "./calibration-files.js";

/**
 * Profiles every repo in the held-out set alone and reports agreement with the human scores.
 * With --write-results it also stores the judge's raw scores (model output only) in
 * calibration-results.json next to the set, which is what the offline CI gate reads.
 */
export async function runCalibration(
  argv: string[],
  env: NodeJS.ProcessEnv,
  log: Log,
  cwd = process.cwd(),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: "string" },
      results: { type: "string" },
      "write-results": { type: "boolean", default: false },
    },
  });
  const { setFile: file, resultsFile } = resolveFiles(values, cwd);
  const set = CalibrationSetSchema.parse(JSON.parse(await readFile(file, "utf8")));
  for (const warning of compositionWarnings(set)) log(`warning: ${warning}`);
  if (set.entries.length === 0) {
    log(
      "The calibration set is empty. Two people must score the repos by hand first: see apps/api/src/profile-pipeline/calibration/README.md.",
    );
    return 1;
  }
  const environment = readEnvironment(env);
  const githubToken = env["GITHUB_TOKEN"];
  const geminiApiKey = environment.GEMINI_API_KEY;
  if (!githubToken || !geminiApiKey) {
    log("Calibration needs GITHUB_TOKEN and GEMINI_API_KEY.");
    return 1;
  }

  log(
    `Model ${environment.GEMINI_MODEL} · prompt ${promptVersion} · taxonomy ${taxonomyVersion} · rubric ${rubricVersion} · sampler ${samplerVersion}`,
  );
  const scores: EntryScore[] = [];
  const scored: ScoredRepository[] = [];
  try {
    for (const entry of set.entries) {
      log(`\n${entry.repository} (${entry.kind})`);
      const facts = await collectRepository({
        repository: entry.repository,
        githubToken,
        repoTokenBudget: environment.REPO_TOKEN_BUDGET,
        log,
      });
      if (!facts.included) {
        log(`  not judged: ${facts.exclusionReason}`);
        scores.push(scoreEntry(entry, null));
        scored.push({ repository: entry.repository, judgedCommitSha: null, model: null });
        continue;
      }
      if (facts.commitSha.toLowerCase() !== entry.commitSha.toLowerCase()) {
        log(
          `  warning: scored at ${entry.commitSha.slice(0, 12)}, HEAD is now ${facts.commitSha.slice(0, 12)}`,
        );
      }
      const { judgment } = await judgeAndAggregate({
        personId: entry.repository,
        displayName: entry.repository,
        geminiApiKey,
        model: environment.GEMINI_MODEL,
        repositories: [facts],
        cv: noCv,
        pages: [],
      });
      const model = judgment.repos[0] ?? null;
      const score = scoreEntry(entry, model);
      scores.push(score);
      scored.push({ repository: entry.repository, judgedCommitSha: facts.commitSha, model });
      for (const item of score.dimensions) {
        log(
          `  ${item.within ? "ok  " : "MISS"} ${item.dimension.padEnd(22)} humans ${item.scorerA}/${item.scorerB} (mean ${item.humanMean}) model ${item.model ?? "-"}${item.humansDisagree ? "  [scorers disagree by >1]" : ""}`,
        );
      }
    }
  } catch (error) {
    if (error instanceof RetryLaterError) {
      log(`${error.message}: rate limited, retry after ${error.retryAt.toISOString()}.`);
      return 75;
    }
    throw error;
  }
  const summary = summarize(scores);
  log(`\n${summary.line}`);
  if (values["write-results"]) {
    const results = buildResults({
      set,
      scored,
      versions: { model: environment.GEMINI_MODEL, ...currentVersions },
      now: new Date(),
    });
    await writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    log(`Wrote ${resultsFile}. Commit it: the CI gate reads it.`);
  }
  return summary.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCalibration(
    process.argv.slice(2),
    process.env,
    (line) => console.log(line),
    process.env["INIT_CWD"] ?? process.cwd(),
  );
}
