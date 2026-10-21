import { describe, expect, it } from "vitest";
import type { PersonProfile, RankingParams, Team } from "../schemas.js";
import {
  workedExampleParams,
  workedExampleProfiles,
  workedExampleTeams,
} from "./__tests__/fixtures.js";
import { rank, resolveRankingParams, scoreValidated, validateRankInputs } from "./rank.js";

function generateSyntheticDataset(profileCount: number, teamCount: number) {
  const skillsList = ["ai_ml", "backend", "frontend", "design_ui_ux", "data_science", "devops"];
  const profiles: PersonProfile[] = Array.from({ length: profileCount }, (_, i) => ({
    personId: `person-${i}`,
    displayName: `Person ${i}`,
    skills: skillsList.slice(0, 3 + (i % 3)).map((id, sIdx) => ({
      id,
      level: 1 + ((i * 7 + sIdx * 11) % 5),
      confidence: (["low", "medium", "high"] as const)[(i + sIdx) % 3]!,
      effective: 1 + ((i * 7 + sIdx * 11) % 5),
      evidence: [],
      thought: "synthetic",
    })),
    novelty: (i % 10) / 10,
    flags: i % 20 === 0 ? ["mostly_boilerplate" as const] : [],
  }));

  const teams: Team[] = Array.from({ length: teamCount }, (_, i) => {
    const memberCount = 2 + (i % 3);
    const memberIds = Array.from(
      { length: memberCount },
      (_, mIdx) => `person-${(i * 3 + mIdx) % profileCount}`,
    );
    return {
      teamId: `team-${i}`,
      name: `Team ${i}`,
      memberIds,
      submittedAt: new Date(1700000000000 + i * 60000).toISOString(),
    };
  });

  const params: RankingParams = {
    requirements: [
      { skill: "ai_ml", target: 3, weight: 3, coverage: { mode: "any_member" } },
      { skill: "backend", target: 3, weight: 2, coverage: { mode: "any_member" } },
      { skill: "frontend", target: 2, weight: 2, coverage: { mode: "any_member" } },
    ],
    alpha: 0.7,
    noveltyWeight: 10,
    confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
    minFit: 0,
    minTeamSize: 1,
    maxTeamSize: 5,
  };

  return { profiles, teams, params };
}

describe("Fast scoring path: Golden tests", () => {
  it("produces identical rankings between rank() and scoreValidated() on worked example", () => {
    const fromRank = rank(workedExampleProfiles, workedExampleTeams, workedExampleParams);

    const { profilesById, teams, params } = validateRankInputs(
      workedExampleProfiles,
      workedExampleTeams,
      workedExampleParams,
    );
    const fromScoreValidated = scoreValidated(profilesById, teams, params);

    expect(fromScoreValidated).toEqual(fromRank);
  });

  it("produces identical rankings between rank() and scoreValidated() on synthetic 500 profiles / 100 teams", () => {
    const { profiles, teams, params } = generateSyntheticDataset(500, 100);

    const fromRank = rank(profiles, teams, params);

    const {
      profilesById,
      teams: validatedTeams,
      params: resolvedParams,
    } = validateRankInputs(profiles, teams, params);
    const fromScoreValidated = scoreValidated(profilesById, validatedTeams, resolvedParams);

    expect(fromScoreValidated).toEqual(fromRank);
    expect(fromScoreValidated.length).toBe(100);
  });
});
