import { z } from "zod";

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

export const ProfileSkillSchema = z.object({
  id: SkillIdSchema,
  level: z.number().min(1).max(5),
  confidence: ConfidenceSchema,
  effective: EffectiveLevelSchema,
  evidence: z.array(EvidenceSchema).default([]),
  thought: z.string().max(600).default(""),
});

export const PersonProfileSchema = z.object({
  personId: IdentifierSchema,
  displayName: z.string().trim().min(1).max(120),
  skills: z.array(ProfileSkillSchema),
  novelty: z.number().min(0).max(1),
  flags: z
    .array(z.enum(["possible_prompt_injection", "readme_overclaims", "mostly_boilerplate"]))
    .default([]),
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

export const RankingParamsSchema = z
  .object({
    requirements: z.array(RequirementSchema).min(1),
    alpha: z.number().min(0).max(1).default(0.7),
    noveltyWeight: z.number().min(0).max(25).default(10),
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

export type Evidence = z.infer<typeof EvidenceSchema>;
export type ProfileSkill = z.infer<typeof ProfileSkillSchema>;
export type PersonProfile = z.infer<typeof PersonProfileSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type RankingParams = z.infer<typeof RankingParamsSchema>;
export type Hackathon = z.infer<typeof HackathonSchema>;
