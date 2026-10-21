import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { evaluateGate } from "../profile-pipeline/calibration/report.js";
import { currentVersions, readJson, resolveFiles } from "./calibration-files.js";

/**
 * The CI gate for judge accuracy. Offline: it reads the committed human labels and the committed
 * judge results, never the network.
 *   - fewer than 10 entries: PENDING, exit 0 (accuracy is not measured yet; says so)
 *   - 10 entries: exit 1 unless the set is valid, the results are fresh for these labels and the
 *     current versions, and the judge is within +-1 of the human mean on at least 8 of 10 repos
 */
export async function runCalibrationGate(
  argv: string[],
  log: (line: string) => void,
  cwd = process.cwd(),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { set: { type: "string" }, results: { type: "string" } },
  });
  const { setFile, resultsFile } = resolveFiles(values, cwd);

  const set = await readJson(setFile);
  if (set.kind !== "ok") {
    log(
      set.kind === "missing"
        ? `Calibration gate: FAIL - no calibration set at ${setFile}.`
        : `Calibration gate: FAIL - ${set.message}`,
    );
    return 1;
  }
  const results = await readJson(resultsFile);
  if (results.kind === "invalid") {
    log(`Calibration gate: FAIL - ${results.message}`);
    return 1;
  }

  const decision = evaluateGate(
    set.value,
    results.kind === "ok" ? results.value : undefined,
    currentVersions,
  );
  for (const line of decision.lines) log(line);
  return decision.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCalibrationGate(
    process.argv.slice(2),
    (line) => console.log(line),
    process.env["INIT_CWD"] ?? process.cwd(),
  );
}
