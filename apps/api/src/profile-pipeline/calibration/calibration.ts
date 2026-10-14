import { taxonomyIds } from "@talentradar/shared";
import { z } from "zod";
import { fewShots } from "../few-shot.js";

/*
 * Held-out calibration (spec: Risks -> "Scores don't match human judgment"). Ten public repos, each
 * scored by two people independently, never used as few-shot examples. The judge is run on each
 * repo alone; a repo counts as "within" when the model's originality and every human-scored skill
 * level are within +-1 of the two scorers' mean. Target: within on at least 8 of 10.
 */

export const CALIBRATION_SIZE = 10;
export const CALIBRATION_TARGET = 8;

const LevelSchema = z.number().int().min(1).max(5);
const TwoScoresSchema = z.object({ scorerA: LevelSchema, scorerB: LevelSchema }).strict();
const knownIds = new Set<string>(taxonomyIds);
const shotRepositories = new Set(fewShots.map((shot) => shot.input.repository.toLowerCase()));

export const CalibrationEntrySchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    /** The commit both people scored; the runner warns when the repo has moved on. */
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
    kind: z.enum(["genuine_novel", "looks_novel_but_not", "ordinary"]),
    originality: TwoScoresSchema,
    skills: z
      .record(z.string(), TwoScoresSchema)
      .refine((skills) => Object.keys(skills).length > 0, "Score at least one skill")
      .refine(
        (skills) => Object.keys(skills).every((id) => knownIds.has(id)),
        "Skill ids must be taxonomy ids",
      ),
    notes: z.string().max(1000).optional(),
  })
  .strict()
  .refine((entry) => !shotRepositories.has(entry.repository.toLowerCase()), {
    message: "A few-shot example repo cannot be in the calibration set",
    path: ["repository"],
  });

export const CalibrationSetSchema = z
  .object({
    $comment: z.string().optional(),
    entries: z.array(CalibrationEntrySchema).max(CALIBRATION_SIZE),
  })
  .strict()
  .refine(
    (set) =>
      new Set(set.entries.map((entry) => entry.repository.toLowerCase())).size ===
      set.entries.length,
    { message: "Each repo may appear once", path: ["entries"] },
  );

export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>;
export type CalibrationSet = z.infer<typeof CalibrationSetSchema>;

/** What the judge said about one repo; null when the repo could not be judged. */
export interface ModelRepoScore {
  originality: number;
  skills: ReadonlyArray<{ id: string; level: number }>;
}

export interface DimensionScore {
  dimension: string;
  scorerA: number;
  scorerB: number;
  humanMean: number;
  model: number | null;
  within: boolean;
  /** The two people disagree by more than a level: the label itself needs a second look. */
  humansDisagree: boolean;
}

export interface EntryScore {
  repository: string;
  within: boolean;
  dimensions: DimensionScore[];
}

function dimension(
  name: string,
  scores: z.infer<typeof TwoScoresSchema>,
  model: number | null,
): DimensionScore {
  const humanMean = (scores.scorerA + scores.scorerB) / 2;
  return {
    dimension: name,
    scorerA: scores.scorerA,
    scorerB: scores.scorerB,
    humanMean,
    model,
    within: model !== null && Math.abs(model - humanMean) <= 1,
    humansDisagree: Math.abs(scores.scorerA - scores.scorerB) > 1,
  };
}

/** A repo is within only if originality and every human-scored skill are within +-1. */
export function scoreEntry(entry: CalibrationEntry, model: ModelRepoScore | null): EntryScore {
  const dimensions = [
    dimension("originality", entry.originality, model?.originality ?? null),
    ...Object.entries(entry.skills).map(([id, scores]) =>
      dimension(id, scores, model?.skills.find((skill) => skill.id === id)?.level ?? null),
    ),
  ];
  return {
    repository: entry.repository,
    within: dimensions.every((item) => item.within),
    dimensions,
  };
}

export interface CalibrationSummary {
  within: number;
  total: number;
  passed: boolean;
  line: string;
}

export function summarize(scores: readonly EntryScore[]): CalibrationSummary {
  const within = scores.filter((score) => score.within).length;
  const passed = scores.length === CALIBRATION_SIZE && within >= CALIBRATION_TARGET;
  return {
    within,
    total: scores.length,
    passed,
    line: `Within +-1 level on ${within} of ${scores.length} (target: at least ${CALIBRATION_TARGET} of ${CALIBRATION_SIZE}) - ${passed ? "PASS" : "FAIL"}`,
  };
}

/** Warnings about the set itself: size and the spec's required mix of hard cases. */
export function compositionWarnings(set: CalibrationSet): string[] {
  const count = (kind: CalibrationEntry["kind"]) =>
    set.entries.filter((entry) => entry.kind === kind).length;
  return [
    ...(set.entries.length < CALIBRATION_SIZE
      ? [`The set has ${set.entries.length} of ${CALIBRATION_SIZE} repos.`]
      : []),
    ...(count("genuine_novel") < 2 ? ["The spec asks for two genuine originality-5 repos."] : []),
    ...(count("looks_novel_but_not") < 2
      ? ["The spec asks for two repos that look novel but are not."]
      : []),
  ];
}
