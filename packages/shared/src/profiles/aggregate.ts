import { z } from "zod";
import type { Confidence, Evidence, PersonProfile, ProfileSkill } from "../schemas.js";
import { taxonomy, taxonomyIds } from "../taxonomy/taxonomy.js";

const TaxonomyIdSchema = z.string().refine((value) => taxonomyIds.includes(value), {
  message: "Unknown taxonomy id",
});

const JudgmentEvidenceSchema = z.object({
  path: z.string().min(1).max(1024),
  note: z.string().min(1).max(500),
});

export const NO_DOMAIN_EVIDENCE = "No evidence in the reviewed inputs.";

export const DomainScoreSchema = z
  .object({
    evidence: z.array(JudgmentEvidenceSchema),
    thought: z.string().min(1).max(600),
    level: z.number().int().min(0).max(5),
  })
  .superRefine((score, context) => {
    if ((score.level === 0) !== (score.evidence.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Domain 0 means no evidence; positive domain scores require evidence",
      });
    }
  });

/** Every domain is an explicit model decision; omitted domains are never defaulted to zero. */
export const DomainScoresSchema = z
  .object(Object.fromEntries(Object.keys(taxonomy.domains).map((id) => [id, DomainScoreSchema])))
  .strict();

export const RepositorySkillJudgmentSchema = z
  .object({
    id: TaxonomyIdSchema,
    evidence: z.array(JudgmentEvidenceSchema),
    thought: z.string().max(600),
    level: z.number().int().min(0).max(5),
  })
  .superRefine((skill, context) => {
    const noEvidenceDomain = Object.hasOwn(taxonomy.domains, skill.id) && skill.level === 0;
    if (
      noEvidenceDomain
        ? skill.evidence.length > 0
        : skill.level === 0 || skill.evidence.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Only unevidenced domains can have level 0; positive skills require evidence",
      });
    }
  });

export const RepositoryJudgmentSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i),
  pushedAt: z.iso.datetime({ offset: true }),
  authorship: z.number().min(0).max(1),
  originality: z.number().int().min(1).max(5),
  skills: z.array(RepositorySkillJudgmentSchema),
});

export const CvClaimSchema = z.object({
  id: TaxonomyIdSchema,
  quote: z.string().min(1).max(500),
  thought: z.string().max(600),
  level: z.number().int().min(1).max(5),
});

export const ProfileJudgmentSchema = z.object({
  thoughts: z.string().max(1000),
  summary: z.string().min(1).max(600),
  repos: z.array(RepositoryJudgmentSchema),
  cv: z.object({ claims: z.array(CvClaimSchema) }),
  flags: z.array(z.enum(["possible_prompt_injection", "readme_overclaims", "mostly_boilerplate"])),
});

export type ProfileJudgment = z.infer<typeof ProfileJudgmentSchema>;
export type RepositoryJudgment = z.infer<typeof RepositoryJudgmentSchema>;

const originalityFactors: Record<number, number> = {
  1: 0.3,
  2: 0.5,
  3: 0.75,
  4: 1,
  5: 1.5,
};

const confidenceFactors: Record<Confidence, number> = {
  high: 1,
  medium: 0.85,
  low: 0.6,
};

/*
 * Skill aggregation blend. A person's level in a skill is mostly what their best repository shows
 * (an expert who also has two small, older demos must not be dragged down to the average), with
 * the weighted average as a counterweight so one lucky repository cannot carry the skill alone.
 * Both shares must sum to 1 so the blended level stays on the 1..5 scale.
 */
export const SKILL_TOP_SHARE = 0.6;
export const SKILL_AVERAGE_SHARE = 0.4;
/** At most this many repositories feed one skill; the top three by weighted level. */
export const MAX_REPOS_PER_SKILL = 3;

/** exp(-ageYears / RECENCY_TIME_CONSTANT_YEARS): 1 year old is 0.72, 2 years 0.51, 3 years 0.37. */
export const RECENCY_TIME_CONSTANT_YEARS = 3;
/** Old work still counts for something: the factor never falls below this. */
export const RECENCY_FLOOR = 0.4;
const MILLISECONDS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Maps a push timestamp to a weight in [RECENCY_FLOOR, 1]. Injectable so tests can pin it. */
export type RecencyFunction = (pushedAt: string, now: Date) => number;

/** Continuous decay with a floor, replacing the old 1 / 0.8 / 0.6 buckets and their cliffs. */
export const recencyFactor: RecencyFunction = (pushedAt, now) => {
  const ageYears = Math.max(0, now.getTime() - Date.parse(pushedAt)) / MILLISECONDS_PER_YEAR;
  const decayed = Math.exp(-ageYears / RECENCY_TIME_CONSTANT_YEARS);
  return Number.isFinite(decayed) ? Math.max(RECENCY_FLOOR, decayed) : RECENCY_FLOOR;
};

/** The most the upstream-contribution signal can add to any skill level. */
export const MAX_UPSTREAM_BONUS = 0.5;
/** Each merged pull request into someone else's repository is worth this much, up to the cap. */
export const UPSTREAM_BONUS_PER_PR = 0.1;
/** Skills below this level are not lifted: a tutorial-level skill is not helped by outside PRs. */
export const UPSTREAM_BONUS_MIN_LEVEL = 2;

/** Facts about a person (not one repository) that come from deterministic GitHub reads. */
export interface ParticipantSignals {
  /** Pull requests by this person, merged into repositories they do not own. */
  mergedUpstreamPullRequests: number;
}

/** Bounded bonus for merged upstream pull requests: linear, then capped at MAX_UPSTREAM_BONUS. */
export function upstreamBonus(mergedUpstreamPullRequests: number): number {
  if (!Number.isFinite(mergedUpstreamPullRequests) || mergedUpstreamPullRequests <= 0) return 0;
  return Math.min(MAX_UPSTREAM_BONUS, mergedUpstreamPullRequests * UPSTREAM_BONUS_PER_PR);
}

export interface AggregateOptions {
  /** Defaults to the continuous recencyFactor. */
  recency?: RecencyFunction;
  /** Deterministic GitHub signals; omitted means no bonus (profiles built before they existed). */
  signals?: ParticipantSignals;
}

function repoWeight(repository: RepositoryJudgment, now: Date, recency: RecencyFunction): number {
  const authorship = Math.min(1, Math.max(0.2, repository.authorship));
  return (
    authorship *
    recency(repository.pushedAt, now) *
    (originalityFactors[repository.originality] ?? 0)
  );
}

/** Originality 1..5 mapped linearly onto 0..1 (1 -> 0, 5 -> 1). */
export function originalityNovelty(originality: number): number {
  return Math.min(1, Math.max(0, (originality - 1) / 4));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function aggregateProfile(
  personId: string,
  displayName: string,
  rawJudgment: ProfileJudgment,
  now = new Date(),
  options: AggregateOptions = {},
): PersonProfile {
  const recency = options.recency ?? recencyFactor;
  const bonus = upstreamBonus(options.signals?.mergedUpstreamPullRequests ?? 0);
  const judgment = ProfileJudgmentSchema.parse(rawJudgment);
  const skillIds = new Set([
    ...Object.keys(taxonomy.domains),
    ...judgment.repos.flatMap((repository) => repository.skills.map((skill) => skill.id)),
    ...judgment.cv.claims.map((claim) => claim.id),
  ]);

  const skills: ProfileSkill[] = [...skillIds].map((skillId) => {
    const contributions = judgment.repos
      .flatMap((repository) => {
        const skill = repository.skills.find((candidate) => candidate.id === skillId);
        if (!skill) return [];
        const weight = repoWeight(repository, now, recency);
        return [{ repository, skill, weight, weightedLevel: weight * skill.level }];
      })
      .sort(
        (left, right) =>
          right.weightedLevel - left.weightedLevel ||
          left.repository.repo.localeCompare(right.repository.repo),
      )
      .slice(0, MAX_REPOS_PER_SKILL);
    const claim = judgment.cv.claims.find((candidate) => candidate.id === skillId);
    const totalWeight = contributions.reduce((sum, contribution) => sum + contribution.weight, 0);
    // The best repository (highest weighted level) sets the top level; the weighted average
    // over all counted repositories tempers it. One repository gives the same level as before.
    const blended = (() => {
      const best = contributions[0];
      if (!best) return claim?.level ?? 1;
      const topLevel = best.skill.level;
      const weightedAverage =
        contributions.reduce((sum, contribution) => sum + contribution.weightedLevel, 0) /
        totalWeight;
      return SKILL_TOP_SHARE * topLevel + SKILL_AVERAGE_SHARE * weightedAverage;
    })();
    const level =
      contributions.length > 0 && blended >= UPSTREAM_BONUS_MIN_LEVEL
        ? Math.min(5, blended + bonus)
        : blended;
    const confidence: Confidence =
      contributions.length >= 2 || (contributions.length === 1 && claim)
        ? "high"
        : contributions.length === 1
          ? "medium"
          : "low";
    const evidence: Evidence[] = contributions.flatMap(({ repository, skill }) =>
      skill.evidence.map((item) => ({
        repository: repository.repo,
        commitSha: repository.commitSha,
        path: item.path,
        note: item.note,
      })),
    );
    return {
      id: skillId,
      level: round(level),
      confidence,
      effective: round(level * confidenceFactors[confidence]),
      evidence,
      thought: (
        contributions.map((contribution) => contribution.skill.thought).join(" ") ||
        claim?.thought ||
        (skillId in taxonomy.domains ? "No evidence for this domain in the reviewed inputs." : "")
      ).slice(0, 600),
    };
  });

  // Continuous: the best repository's originality (1..5) scaled to 0..1, counted only when the
  // repository shows at least one level-3 skill, as before. Replaces the 1 / 0.25 / 0 buckets.
  const novelty = round(
    Math.max(
      0,
      ...judgment.repos.map((repository) =>
        repository.skills.some((skill) => skill.level >= 3)
          ? originalityNovelty(repository.originality)
          : 0,
      ),
    ),
  );

  return {
    personId,
    displayName,
    skills: skills.sort(
      (left, right) => right.effective - left.effective || left.id.localeCompare(right.id),
    ),
    novelty,
    flags: judgment.flags,
    summary: judgment.summary,
  };
}

/** A tool the stage-2 detectors found in one repository (manifest, file, path or language rule). */
export interface DetectedTool {
  repository: string;
  commitSha: string;
  id: string;
  reasons: string[];
}

export const UNANALYSED_NOTE = "No analysis done for this";

/**
 * Keeps every detected tool the model didn't judge: level 3, low confidence, marked unanalysed.
 * Concept-only matches (text heuristics like `concepts:aria`) are skipped: they aren't evidence of
 * a tool. Evidence points at the repository root at the scored commit, since a manifest may live
 * in a subfolder and a guessed file path could 404.
 */
export function withDetectedTools(profile: PersonProfile, detected: DetectedTool[]): PersonProfile {
  const judged = new Set(profile.skills.map((skill) => skill.id));
  const byId = new Map<string, DetectedTool[]>();
  for (const tool of detected) {
    if (judged.has(tool.id) || !(tool.id in taxonomy.technologies)) continue;
    if (tool.reasons.every((reason) => reason.startsWith("concepts:"))) continue;
    byId.set(tool.id, [...(byId.get(tool.id) ?? []), tool]);
  }
  const added: ProfileSkill[] = [...byId].map(([id, tools]) => ({
    id,
    level: 3,
    confidence: "low",
    effective: round(3 * confidenceFactors.low),
    evidence: tools.map((tool) => ({
      repository: tool.repository,
      commitSha: tool.commitSha,
      path: "/",
      note: `Detected by ${tool.reasons.join(", ")}. ${UNANALYSED_NOTE}.`,
    })),
    thought: `${UNANALYSED_NOTE}: found by the dependency and file detectors, not judged by the model.`,
  }));
  return { ...profile, skills: [...profile.skills, ...added] };
}
