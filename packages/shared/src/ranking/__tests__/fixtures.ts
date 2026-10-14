import type { PersonProfile, RankingParams, Team } from "../../schemas.js";

function skill(id: string, effective: number) {
  return {
    id,
    level: effective,
    confidence: "high" as const,
    effective,
    evidence: [],
    thought: "Synthetic ranking fixture",
  };
}

export const workedExampleProfiles = [
  {
    personId: "riya",
    displayName: "Riya",
    skills: [skill("ai_ml", 3.6), skill("backend", 1.5)],
    novelty: 0.25,
    flags: [],
  },
  {
    personId: "kabir",
    displayName: "Kabir",
    skills: [skill("backend", 3.2), skill("frontend", 2.4)],
    novelty: 0,
    flags: [],
  },
  {
    personId: "meera",
    displayName: "Meera",
    skills: [skill("frontend", 1.8), skill("design_ui_ux", 2.5)],
    novelty: 0,
    flags: [],
  },
  {
    personId: "arjun",
    displayName: "Arjun",
    skills: [skill("ai_ml", 4.5), skill("backend", 3.8), skill("frontend", 3)],
    novelty: 0.25,
    flags: [],
  },
  { personId: "sana", displayName: "Sana", skills: [skill("ai_ml", 4.1)], novelty: 0, flags: [] },
  { personId: "dev", displayName: "Dev", skills: [skill("ai_ml", 3.9)], novelty: 0, flags: [] },
] satisfies PersonProfile[];

export const workedExampleTeams = [
  {
    teamId: "alpha",
    name: "Team Alpha",
    memberIds: ["riya", "kabir", "meera"],
    submittedAt: "2026-10-10T10:00:00.000Z",
  },
  {
    teamId: "beta",
    name: "Team Beta",
    memberIds: ["arjun", "sana", "dev"],
    submittedAt: "2026-10-10T10:01:00.000Z",
  },
] satisfies Team[];

export const workedExampleParams = {
  requirements: [
    { skill: "ai_ml", target: 3, weight: 3, coverage: { mode: "any_member" } },
    { skill: "backend", target: 3, weight: 2, coverage: { mode: "any_member" } },
    { skill: "frontend", target: 2, weight: 2, coverage: { mode: "any_member" } },
    { skill: "design_ui_ux", target: 2, weight: 1, coverage: { mode: "any_member" } },
  ],
  alpha: 0.7,
  noveltyWeight: 10,
  confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
  minFit: 0,
  minTeamSize: 1,
  maxTeamSize: 4,
} satisfies RankingParams;
