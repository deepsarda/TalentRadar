import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  checkResults,
  formatAgreement,
  formatJudgeVsHuman,
  scorerAgreement,
  validateSet,
} from "../profile-pipeline/calibration/report.js";
import { currentVersions, readJson, resolveFiles } from "./calibration-files.js";

/**
 * Offline check of the hand-filled calibration set plus a report: how well the two scorers agree
 * with each other and, when `calibration-results.json` exists, how well the judge agrees with
 * them. Needs no API keys. Exit 0 when the set is valid, 1 when it has errors (or warnings under
 * --strict).
 */
export async function runCalibrationValidate(
  argv: string[],
  log: (line: string) => void,
  cwd = process.cwd(),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: "string" },
      results: { type: "string" },
      strict: { type: "boolean", default: false },
    },
  });
  const { setFile, resultsFile } = resolveFiles(values, cwd);

  const read = await readJson(setFile);
  if (read.kind !== "ok") {
    log(read.kind === "missing" ? `No calibration set at ${setFile}.` : read.message);
    return 1;
  }
  const validation = validateSet(read.value);
  for (const error of validation.errors) log(`error: ${error}`);
  for (const warning of validation.warnings) log(`warning: ${warning}`);
  if (!validation.set) {
    log(`\nInvalid: ${validation.errors.length} error(s).`);
    return 1;
  }
  const { set } = validation;

  log(`\n${set.entries.length} entries, valid.\n`);
  for (const line of formatAgreement(scorerAgreement(set))) log(line);

  const results = await readJson(resultsFile);
  if (results.kind === "invalid") {
    log(`\nerror: ${results.message}`);
    return 1;
  }
  if (results.kind === "missing") {
    log("\nNo judge results yet. Run `pnpm calibrate --write-results` to produce them.");
  } else {
    const check = checkResults(set, results.value, currentVersions);
    log("");
    if (check.scores) {
      const { versions, generatedAt } = check.results ?? {};
      if (versions) {
        log(
          `Judge results from ${generatedAt}: model ${versions.model} · prompt ${versions.prompt} · taxonomy ${versions.taxonomy} · rubric ${versions.rubric} · sampler ${versions.sampler}`,
        );
      }
      for (const line of formatJudgeVsHuman(check.scores)) log(line);
    } else {
      log("Judge results are stale or unusable, so no judge-vs-human figure is shown:");
      for (const error of check.errors) log(`  error: ${error}`);
    }
  }

  return values.strict && validation.warnings.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCalibrationValidate(
    process.argv.slice(2),
    (line) => console.log(line),
    process.env["INIT_CWD"] ?? process.cwd(),
  );
}
