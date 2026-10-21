import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptVersion, rubricVersion, samplerVersion, taxonomyVersion } from "@talentradar/shared";
import type { CalibrationVersions } from "../profile-pipeline/calibration/report.js";

/** Where the calibration files live and how the offline CLIs find them. */

export const defaultSetFile = new URL(
  "../profile-pipeline/calibration/calibration-set.json",
  import.meta.url,
);

/** The judge's raw scores, written by `pnpm calibrate --write-results`. Model output only. */
export const resultsFileName = "calibration-results.json";

/** The versions the code is at right now; stored results must have been produced under these. */
export const currentVersions: Omit<CalibrationVersions, "model"> = {
  prompt: promptVersion,
  taxonomy: taxonomyVersion,
  rubric: rubricVersion,
  sampler: samplerVersion,
};

export function resolveFiles(
  values: { set?: string | undefined; results?: string | undefined },
  cwd: string,
): { setFile: string; resultsFile: string } {
  const setFile = values.set ? path.resolve(cwd, values.set) : fileURLToPath(defaultSetFile);
  const resultsFile = values.results
    ? path.resolve(cwd, values.results)
    : path.join(path.dirname(setFile), resultsFileName);
  return { setFile, resultsFile };
}

export type JsonRead =
  | { kind: "ok"; value: unknown }
  | { kind: "missing" }
  | { kind: "invalid"; message: string };

/** Reads JSON, telling "no such file" apart from "not valid JSON". */
export async function readJson(file: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch (error) {
    return { kind: "invalid", message: `${file} is not valid JSON: ${(error as Error).message}` };
  }
}
