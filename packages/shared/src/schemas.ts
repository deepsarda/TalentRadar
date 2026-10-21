import { z } from "zod";
import { taxonomy } from "./taxonomy/taxonomy.js";

export const IdentifierSchema = z.string().trim().min(1).max(128);
export const SkillIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
export const ProficiencyLevelSchema = z.number().int().min(1).max(5);
export const EffectiveLevelSchema = z.number().min(0).max(5);
export const ConfidenceSchema = z.enum(["low", "medium", "high"]);

export const EvidenceSchema = z.object({
  repository: z.string().regex(/^[^/]+\/[^/]+$/),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/i),
  path: z.string().min(1).max(1024),
  note: z.string().min(1).max(500),
});

export const ProfileSkillSchema = z
  .object({
    id: SkillIdSchema,
    level: z.number().min(0).max(5),
    confidence: ConfidenceSchema,
    effective: EffectiveLevelSchema,
    evidence: z.array(EvidenceSchema).default([]),
    thought: z.string().max(600).default(""),
  })
  .superRefine((skill, context) => {
    if (
      skill.level === 0 &&
      (!Object.hasOwn(taxonomy.domains, skill.id) ||
        skill.evidence.length > 0 ||
        skill.effective !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["level"],
        message: "Level 0 is reserved for domains with no observed evidence",
      });
    }
  });

export const PersonProfileSchema = z.object({
  personId: IdentifierSchema,
  displayName: z.string().trim().min(1).max(120),
  skills: z.array(ProfileSkillSchema),
  novelty: z.number().min(0).max(1),
  flags: z
    .array(z.enum(["possible_prompt_injection", "readme_overclaims", "mostly_boilerplate"]))
    .default([]),
  /** The model's one-paragraph read of the person; absent on profiles built before it was kept. */
  summary: z.string().max(600).optional(),
});

export const TeamSchema = z.object({
  teamId: IdentifierSchema,
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(IdentifierSchema).min(1).max(6),
  submittedAt: z.iso.datetime({ offset: true }),
});

export const CoverageSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("any_member") }),
  z.object({
    mode: z.literal("min_members"),
    minMembers: z.number().int().min(1).max(6),
  }),
]);

export const RequirementSchema = z.object({
  skill: SkillIdSchema,
  target: z.number().min(1).max(5).multipleOf(0.5),
  weight: z.number().int().min(0).max(5),
  coverage: CoverageSchema,
});

export const ProfileFlagSchema = z.enum([
  "possible_prompt_injection",
  "readme_overclaims",
  "mostly_boilerplate",
]);

/**
 * Multiplier (0 to 1) applied to every skill level of a member who carries the flag. A person
 * with several flags gets the product of their multipliers. 1 means "ignore this flag".
 */
export const FlagPenaltiesSchema = z.object({
  possible_prompt_injection: z.number().min(0).max(1).default(0.5),
  readme_overclaims: z.number().min(0).max(1).default(0.85),
  mostly_boilerplate: z.number().min(0).max(1).default(0.8),
});

export const DEFAULT_FLAG_PENALTIES = {
  possible_prompt_injection: 0.5,
  readme_overclaims: 0.85,
  mostly_boilerplate: 0.8,
} as const;

export const RankingParamsSchema = z
  .object({
    requirements: z.array(RequirementSchema).min(1),
    alpha: z.number().min(0).max(1).default(0.7),
    noveltyWeight: z.number().min(0).max(25).default(10),
    confidenceFactors: z
      .object({
        high: z.number().min(0).max(1).default(1),
        medium: z.number().min(0).max(1).default(0.85),
        low: z.number().min(0).max(1).default(0.6),
      })
      .default({ high: 1, medium: 0.85, low: 0.6 }),
    /** Optional so events saved before this existed stay valid; rank() fills in the defaults. */
    flagPenalties: FlagPenaltiesSchema.optional(),
    /**
     * Points (out of 100) given to team synergy: domain coverage minus a redundancy penalty.
     * Optional so saved events stay valid; rank() treats a missing value as 0 (no synergy).
     */
    synergyWeight: z.number().min(0).max(15).optional(),
    /**
     * Share of team novelty taken from the single most novel member; the rest comes from the mean
     * of the two most novel members. Missing means 0.5. 1 reproduces the old "max member" rule.
     */
    noveltyMaxShare: z.number().min(0).max(1).optional(),
    minFit: z.number().min(0).max(1).default(0),
    minTeamSize: z.number().int().min(1).max(6).default(1),
    maxTeamSize: z.number().int().min(1).max(6).default(6),
  })
  .refine((params) => params.minTeamSize <= params.maxTeamSize, {
    message: "Minimum team size cannot exceed maximum team size",
    path: ["minTeamSize"],
  })
  .refine((params) => params.requirements.some((requirement) => requirement.weight > 0), {
    message: "At least one requirement must have a positive weight",
    path: ["requirements"],
  });

export const QuotaRuleSchema = z
  .object({
    attribute: z.enum(["college", "year_of_study", "branch", "city"]),
    op: z.enum(["equals", "not_equals", "in", "not_in"]),
    value: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]),
    minShare: z.number().min(0.01).max(1),
    unit: z.enum(["teams", "participants"]).default("teams"),
    match: z.enum(["any", "majority", "all"]).default("all"),
  })
  .superRefine((quota, context) => {
    const expectsList = quota.op === "in" || quota.op === "not_in";
    if (expectsList !== Array.isArray(quota.value)) {
      context.addIssue({
        code: "custom",
        message: expectsList
          ? "This operator needs a list of values"
          : "This operator needs one value",
        path: ["value"],
      });
    }
  });

export const HackathonTimelineSchema = z
  .object({
    timezone: z.string().min(1).default("Asia/Kolkata"),
    registrationOpensAt: z.iso.datetime({ offset: true }),
    registrationClosesAt: z.iso.datetime({ offset: true }),
    shortlistPublishesAt: z.iso.datetime({ offset: true }),
    rsvpDeadlineAt: z.iso.datetime({ offset: true }),
    eventStartsAt: z.iso.datetime({ offset: true }),
    eventEndsAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    (timeline) =>
      [
        timeline.registrationOpensAt,
        timeline.registrationClosesAt,
        timeline.shortlistPublishesAt,
        timeline.rsvpDeadlineAt,
        timeline.eventStartsAt,
        timeline.eventEndsAt,
      ].every((value, index, values) => index === 0 || value >= (values[index - 1] ?? value)),
    { message: "Timeline values must be chronological" },
  );

export const HackathonSchema = z.object({
  hackathonId: IdentifierSchema,
  kind: z.enum(["event", "quick"]),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(3).max(80),
  organizerIds: z.array(IdentifierSchema).min(1),
  capacity: z.number().int().min(1).max(5000),
  timeline: HackathonTimelineSchema.optional(),
  ranking: RankingParamsSchema,
  visibility: z.enum(["draft", "published", "closed"]),
});

export type ProfileFlag = z.infer<typeof ProfileFlagSchema>;
export type FlagPenalties = z.infer<typeof FlagPenaltiesSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type ProfileSkill = z.infer<typeof ProfileSkillSchema>;
export type PersonProfile = z.infer<typeof PersonProfileSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type RankingParams = z.infer<typeof RankingParamsSchema>;
export type QuotaRule = z.infer<typeof QuotaRuleSchema>;
export type Hackathon = z.infer<typeof HackathonSchema>;
