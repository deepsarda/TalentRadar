import { rank, scoreValidated, validateRankInputs } from "../src/ranking/rank.js";
import type { PersonProfile, RankingParams, Team } from "../src/schemas.js";

function generateBenchmarkDataset(profileCount: number, teamCount: number) {
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
      { skill: "design_ui_ux", target: 2, weight: 1, coverage: { mode: "any_member" } },
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

console.log("Generating benchmark dataset (2000 profiles / 500 teams)...");
const { profiles, teams, params } = generateBenchmarkDataset(2000, 500);

// Warmup
rank(profiles.slice(0, 50), teams.slice(0, 10), params);

console.log("\nRunning benchmark: standard rank() with full Zod validation...");
const startRank = performance.now();
const rankResults = rank(profiles, teams, params);
const endRank = performance.now();
const rankTimeMs = endRank - startRank;
console.log(`rank() took: ${rankTimeMs.toFixed(2)}ms`);

console.log("\nRunning benchmark: pre-validation + scoreValidated()...");
const startValidate = performance.now();
const {
  profilesById,
  teams: validatedTeams,
  params: resolvedParams,
} = validateRankInputs(profiles, teams, params);
const endValidate = performance.now();
const validateTimeMs = endValidate - startValidate;

const startScore = performance.now();
const scoreResults = scoreValidated(profilesById, validatedTeams, resolvedParams);
const endScore = performance.now();
const scoreTimeMs = endScore - startScore;

console.log(`Validation took: ${validateTimeMs.toFixed(2)}ms`);
console.log(`scoreValidated() took: ${scoreTimeMs.toFixed(2)}ms`);
console.log(
  `Speedup (rank() vs scoreValidated()): ${(rankTimeMs / scoreTimeMs).toFixed(2)}x faster`,
);

// Verify identity
const identical = JSON.stringify(rankResults) === JSON.stringify(scoreResults);
console.log(`\nResults identical: ${identical}`);
if (!identical) {
  process.exit(1);
}
