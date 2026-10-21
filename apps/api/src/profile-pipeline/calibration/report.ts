import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CALIBRATION_SIZE,
  type CalibrationEntry,
  CalibrationEntrySchema,
  type CalibrationSet,
  CalibrationSetSchema,
  compositionWarnings,
  type EntryScore,
  type ModelRepoScore,
  scoreEntry,
  summarize,
} from "./calibration.js";

/*
 * Calibration tooling that needs no network and no API keys, so CI can run it:
 *   - validateSet: is the hand-filled set well formed (40-char SHA, two scorers, taxonomy ids)?
 *   - scorerAgreement: how often do the two people agree with each other?
 *   - judge results: the judge's raw scores, stored by `pnpm calibrate --write-results`, stamped
 *     with a digest of the labels and every version identifier, so a stale file cannot pass.
 *   - evaluateGate: the CI decision (pending below 10 entries, else pass/fail at 8 of 10).
 *
 * Nothing here creates human labels. The results file holds MODEL output only.
 */

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export interface ValidationReport {
  /** Null when there are errors: an invalid set must not be scored. */
  set: CalibrationSet | null;
  errors: string[];
  warnings: string[];
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

function formatIssues(
  label: string,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string[] {
  return issues.map((issue) => {
    const where = formatPath(issue.path);
    return `${label}${where ? ` ${where}` : ""}: ${issue.message}`;
  });
}

/** Checks every entry on its own so each problem is reported with the repo it belongs to. */
export function validateSet(raw: unknown): ValidationReport {
  const root = z
    .object({ entries: z.array(z.unknown()) })
    .passthrough()
    .safeParse(raw);
  if (!root.success) {
    return {
      set: null,
      errors: ['The file must be a JSON object with an "entries" array.'],
      warnings: [],
    };
  }

  const errors: string[] = [];
  const entries = root.data.entries;
  entries.forEach((candidate, index) => {
    const repository =
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as { repository?: unknown }).repository === "string"
        ? (candidate as { repository: string }).repository
        : undefined;
    const label = `entry ${index + 1}${repository ? ` (${repository})` : ""}`;
    const parsed = CalibrationEntrySchema.safeParse(candidate);
    if (!parsed.success) errors.push(...formatIssues(label, parsed.error.issues));
  });

  // Set-level rules (duplicates, size, unknown top-level keys) only once entries are individually
  // valid, so one typo does not bury the message that matters.
  if (errors.length === 0) {
    const set = CalibrationSetSchema.safeParse(raw);
    if (!set.success) errors.push(...formatIssues("set", set.error.issues));
    else {
      const agreement = scorerAgreement(set.data);
      const warnings = [
        ...compositionWarnings(set.data),
        ...agreement.disagreements.map(
          (row) =>
            `${row.repository}: scorers differ by more than one level on ${row.dimension} (${row.scorerA} vs ${row.scorerB}). Re-score together; do not average it away.`,
        ),
      ];
      return { set: set.data, errors, warnings };
    }
  }
  return { set: null, errors, warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Agreement between the two human scorers
// ---------------------------------------------------------------------------------------------

export interface AgreementRow {
  repository: string;
  dimension: string;
  scorerA: number;
  scorerB: number;
  difference: number;
}

export interface ScorerAgreement {
  repositories: number;
  dimensions: number;
  exact: number;
  withinOne: number;
  /** Null for an empty set. */
  meanAbsoluteDifference: number | null;
  /** Dimensions the scorers split by more than one level. */
  disagreements: AgreementRow[];
}

function rowsOf(entry: CalibrationEntry): AgreementRow[] {
  const toRow = (
    dimension: string,
    scores: { scorerA: number; scorerB: number },
  ): AgreementRow => ({
    repository: entry.repository,
    dimension,
    scorerA: scores.scorerA,
    scorerB: scores.scorerB,
    difference: Math.abs(scores.scorerA - scores.scorerB),
  });
  return [
    toRow("originality", entry.originality),
    ...Object.entries(entry.skills).map(([id, scores]) => toRow(id, scores)),
  ];
}

/** How often the two people agree with each other. Independent of any model output. */
export function scorerAgreement(set: CalibrationSet): ScorerAgreement {
  const rows = set.entries.flatMap(rowsOf);
  const total = rows.reduce((sum, row) => sum + row.difference, 0);
  return {
    repositories: set.entries.length,
    dimensions: rows.length,
    exact: rows.filter((row) => row.difference === 0).length,
    withinOne: rows.filter((row) => row.difference <= 1).length,
    meanAbsoluteDifference: rows.length === 0 ? null : total / rows.length,
    disagreements: rows.filter((row) => row.difference > 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Stored judge results
// ---------------------------------------------------------------------------------------------

export interface CalibrationVersions {
  model: string;
  prompt: string;
  taxonomy: string;
  rubric: string;
  sampler: string;
}

const ModelRepoScoreSchema = z
  .object({
    originality: z.number().min(1).max(5),
    skills: z.array(z.object({ id: z.string(), level: z.number().min(1).max(5) }).strict()),
  })
  .strict();

export const CalibrationResultsSchema = z
  .object({
    generatedAt: z.iso.datetime({ offset: true }),
    /** Digest of the human labels the judge was compared against (see setDigest). */
    setDigest: z.string().regex(/^[a-f0-9]{64}$/),
    versions: z
      .object({
        model: z.string().min(1),
        prompt: z.string().min(1),
        taxonomy: z.string().min(1),
        rubric: z.string().min(1),
        sampler: z.string().min(1),
      })
      .strict(),
    entries: z.array(
      z
        .object({
          repository: z.string(),
          /** The commit the judge actually read; null when the repo could not be judged. */
          judgedCommitSha: z
            .string()
            .regex(/^[a-f0-9]{40}$/i)
            .nullable(),
          /** The judge's repo-level scores; null when the repo could not be judged (counts as a miss). */
          model: ModelRepoScoreSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type CalibrationResults = z.infer<typeof CalibrationResultsSchema>;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const body = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${body.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A fingerprint of everything the humans decided: repos, pinned commits, kinds and every score.
 * Editing a label after the judge ran changes it, so stored results cannot silently outlive the
 * labels they were compared against. Order and key order do not matter; `notes` and `$comment` do
 * not affect scoring and are excluded.
 */
export function setDigest(set: CalibrationSet): string {
  const entries = set.entries
    .map(({ notes: _notes, ...rest }) => rest)
    .sort((left, right) =>
      left.repository.toLowerCase().localeCompare(right.repository.toLowerCase()),
    );
  return createHash("sha256").update(stableStringify(entries)).digest("hex");
}

export interface ScoredRepository {
  repository: string;
  judgedCommitSha: string | null;
  model: ModelRepoScore | null;
}

/** What `pnpm calibrate --write-results` stores. Pure so it can be tested without the judge. */
export function buildResults(options: {
  set: CalibrationSet;
  scored: readonly ScoredRepository[];
  versions: CalibrationVersions;
  now: Date;
}): CalibrationResults {
  return CalibrationResultsSchema.parse({
    generatedAt: options.now.toISOString(),
    setDigest: setDigest(options.set),
    versions: options.versions,
    entries: options.scored.map((item) => ({
      repository: item.repository,
      judgedCommitSha: item.judgedCommitSha,
      model: item.model
        ? {
            originality: item.model.originality,
            skills: item.model.skills.map(({ id, level }) => ({ id, level })),
          }
        : null,
    })),
  });
}

export interface ResultsCheck {
  /** Reasons the stored results cannot be trusted for this set; empty when they can. */
  errors: string[];
  /** Per-entry judge-vs-human scores; null when the results are unusable. */
  scores: EntryScore[] | null;
  results: CalibrationResults | null;
}

const versionKeys = ["model", "prompt", "taxonomy", "rubric", "sampler"] as const;

/**
 * Joins stored judge results to the human labels. Refuses (errors, no scores) when the results are
 * malformed, were produced against different labels, under different versions, for a different
 * commit, or do not cover every entry exactly once. `model` is informational: a model swap shows
 * in the report but is only an error when the caller passes `currentVersions.model`.
 */
export function checkResults(
  set: CalibrationSet,
  rawResults: unknown,
  currentVersions: Omit<CalibrationVersions, "model"> & { model?: string },
): ResultsCheck {
  const parsed = CalibrationResultsSchema.safeParse(rawResults);
  if (!parsed.success) {
    return {
      errors: formatIssues("results", parsed.error.issues),
      scores: null,
      results: null,
    };
  }
  const results = parsed.data;
  const errors: string[] = [];
  const rerun = "Re-run `pnpm calibrate --write-results` and commit the file.";

  if (results.setDigest !== setDigest(set)) {
    errors.push(`The human labels changed after the judge ran. ${rerun}`);
  }
  for (const key of versionKeys) {
    const expected = currentVersions[key];
    if (expected !== undefined && results.versions[key] !== expected) {
      errors.push(
        `Results were produced with ${key} "${results.versions[key]}" but the code is at "${expected}". ${rerun}`,
      );
    }
  }

  const byRepository = new Map<string, CalibrationResults["entries"][number]>();
  for (const item of results.entries) {
    const key = item.repository.toLowerCase();
    if (byRepository.has(key)) errors.push(`results: ${item.repository} appears more than once.`);
    byRepository.set(key, item);
  }
  const known = new Set(set.entries.map((entry) => entry.repository.toLowerCase()));
  for (const key of byRepository.keys()) {
    if (!known.has(key)) errors.push(`results: ${key} is not in the calibration set.`);
  }

  const scores: EntryScore[] = [];
  for (const entry of set.entries) {
    const item = byRepository.get(entry.repository.toLowerCase());
    if (!item) {
      errors.push(`results: no judge result for ${entry.repository}. ${rerun}`);
      continue;
    }
    if (
      item.judgedCommitSha &&
      item.judgedCommitSha.toLowerCase() !== entry.commitSha.toLowerCase()
    ) {
      errors.push(
        `${entry.repository}: the judge read ${item.judgedCommitSha.slice(0, 12)} but the humans scored ${entry.commitSha.slice(0, 12)}, so the comparison is meaningless.`,
      );
    }
    scores.push(scoreEntry(entry, item.model));
  }

  return { errors, scores: errors.length === 0 ? scores : null, results };
}

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------

export type GateStatus = "pending" | "pass" | "fail";

export interface GateDecision {
  status: GateStatus;
  /** 0 for pending and pass, 1 for fail. */
  exitCode: 0 | 1;
  lines: string[];
}

/**
 * The CI decision. Below CALIBRATION_SIZE entries the gate is pending and does not fail the build
 * (there is nothing to measure yet), and says so loudly. With a full set it fails unless the set is
 * valid, the stored judge results are fresh and complete, and the judge is within +-1 of the human
 * mean on at least CALIBRATION_TARGET repos.
 *
 * `rawResults` is undefined when the file does not exist.
 */
export function evaluateGate(
  rawSet: unknown,
  rawResults: unknown,
  currentVersions: Omit<CalibrationVersions, "model"> & { model?: string },
): GateDecision {
  const validation = validateSet(rawSet);
  if (!validation.set) {
    return {
      status: "fail",
      exitCode: 1,
      lines: ["Calibration gate: FAIL - the calibration set is invalid.", ...validation.errors],
    };
  }
  const { set } = validation;
  if (set.entries.length < CALIBRATION_SIZE) {
    return {
      status: "pending",
      exitCode: 0,
      lines: [
        `Calibration gate: PENDING - ${set.entries.length} of ${CALIBRATION_SIZE} entries. The gate is enforced once the set is complete; until then accuracy is NOT being measured.`,
      ],
    };
  }
  if (rawResults === undefined) {
    return {
      status: "fail",
      exitCode: 1,
      lines: [
        `Calibration gate: FAIL - the set is complete but there are no judge results. Run \`pnpm calibrate --write-results\` and commit calibration-results.json.`,
      ],
    };
  }
  const check = checkResults(set, rawResults, currentVersions);
  if (!check.scores) {
    return {
      status: "fail",
      exitCode: 1,
      lines: [
        "Calibration gate: FAIL - the stored judge results cannot be trusted.",
        ...check.errors,
      ],
    };
  }
  const summary = summarize(check.scores);
  const misses = check.scores
    .filter((score) => !score.within)
    .map((score) => `  miss: ${score.repository}`);
  return {
    status: summary.passed ? "pass" : "fail",
    exitCode: summary.passed ? 0 : 1,
    lines: [`Calibration gate: ${summary.line}`, ...(summary.passed ? [] : misses)],
  };
}

// ---------------------------------------------------------------------------------------------
// Report text
// ---------------------------------------------------------------------------------------------

const percent = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`;

export function formatAgreement(agreement: ScorerAgreement): string[] {
  const lines = [
    `Scorer agreement: ${agreement.dimensions} dimensions across ${agreement.repositories} repos`,
  ];
  if (agreement.dimensions === 0) return [...lines, "  nothing to compare yet."];
  lines.push(
    `  exact:        ${agreement.exact}/${agreement.dimensions} (${percent(agreement.exact, agreement.dimensions)})`,
    `  within +-1:   ${agreement.withinOne}/${agreement.dimensions} (${percent(agreement.withinOne, agreement.dimensions)})`,
    `  mean |A - B|: ${(agreement.meanAbsoluteDifference ?? 0).toFixed(2)}`,
  );
  if (agreement.disagreements.length > 0) {
    lines.push("  Scorers differ by more than one level (talk it through and re-score):");
    for (const row of agreement.disagreements) {
      lines.push(`    ${row.repository}  ${row.dimension}  A=${row.scorerA} B=${row.scorerB}`);
    }
  }
  return lines;
}

export function formatJudgeVsHuman(scores: readonly EntryScore[]): string[] {
  const lines = ["Judge vs human:"];
  for (const score of scores) {
    const misses = score.dimensions
      .filter((item) => !item.within)
      .map((item) => `${item.dimension} (model ${item.model ?? "-"} vs humans ${item.humanMean})`);
    lines.push(
      score.within
        ? `  ok    ${score.repository}`
        : `  MISS  ${score.repository}: ${misses.join(", ")}`,
    );
  }
  lines.push(summarize(scores).line);
  return lines;
}
