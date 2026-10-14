import { readFile } from "node:fs/promises";
import path from "node:path";
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
import { noCv } from "../profile-pipeline/judge.js";
import { collectRepository, judgeAndAggregate, type Log } from "../profile-pipeline/local-run.js";

const defaultSet = new URL("../profile-pipeline/calibration/calibration-set.json", import.meta.url);

/** Profiles every repo in the held-out set alone and reports agreement with the human scores. */
export async function runCalibration(
  argv: string[],
  env: NodeJS.ProcessEnv,
  log: Log,
  cwd = process.cwd(),
): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { set: { type: "string" } } });
  const file = values.set ? path.resolve(cwd, values.set) : defaultSet;
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
      const score = scoreEntry(entry, judgment.repos[0] ?? null);
      scores.push(score);
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
