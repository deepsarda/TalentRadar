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
    const noEvidenceDomain = skill.id in taxonomy.domains && skill.level === 0;
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

function recencyFactor(pushedAt: string, now: Date): number {
  const age = now.getTime() - Date.parse(pushedAt);
  if (age <= 365.25 * 24 * 60 * 60 * 1000) return 1;
  if (age <= 2 * 365.25 * 24 * 60 * 60 * 1000) return 0.8;
  return 0.6;
}

function repoWeight(repository: RepositoryJudgment, now: Date): number {
  const authorship = Math.min(1, Math.max(0.2, repository.authorship));
  return (
    authorship *
    recencyFactor(repository.pushedAt, now) *
    (originalityFactors[repository.originality] ?? 0)
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function aggregateProfile(
  personId: string,
  displayName: string,
  rawJudgment: ProfileJudgment,
  now = new Date(),
): PersonProfile {
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
        // An unevidenced repository must not dilute supported domain work or inflate confidence.
        if (!skill || skill.level === 0) return [];
        const weight = repoWeight(repository, now);
        return [{ repository, skill, weight, weightedLevel: weight * skill.level }];
      })
      .sort(
        (left, right) =>
          right.weightedLevel - left.weightedLevel ||
          left.repository.repo.localeCompare(right.repository.repo),
      )
      .slice(0, 3);
    const claim = judgment.cv.claims.find((candidate) => candidate.id === skillId);
    const totalWeight = contributions.reduce((sum, contribution) => sum + contribution.weight, 0);
    const level =
      contributions.length > 0
        ? contributions.reduce((sum, contribution) => sum + contribution.weightedLevel, 0) /
          totalWeight
        : (claim?.level ?? (skillId in taxonomy.domains ? 0 : 1));
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
      thought:
        contributions.map((contribution) => contribution.skill.thought).join(" ") ||
        claim?.thought ||
        (skillId in taxonomy.domains ? "No evidence for this domain in the reviewed inputs." : ""),
    };
  });

  const novelty = Math.max(
    0,
    ...judgment.repos.map((repository) => {
      if (!repository.skills.some((skill) => skill.level >= 3)) return 0;
      if (repository.originality === 5) return 1;
      if (repository.originality === 4) return 0.25;
      return 0;
    }),
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
