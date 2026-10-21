import { describe, expect, it } from "vitest";
import type { PersonProfile, RankingParams, Team } from "../schemas.js";
import { autoFormTeams, findTeamGapFillers } from "./formation.js";

const sampleParams: RankingParams = {
  requirements: [
    {
      skill: "backend",
      target: 4,
      weight: 1,
      coverage: { mode: "any_member" },
    },
    {
      skill: "frontend",
      target: 3,
      weight: 1,
      coverage: { mode: "any_member" },
    },
    {
      skill: "ai_ml",
      target: 3,
      weight: 1,
      coverage: { mode: "any_member" },
    },
  ],
  alpha: 0.7,
  noveltyWeight: 0,
  confidenceFactors: { high: 1, medium: 0.8, low: 0.5 },
  minFit: 0,
  minTeamSize: 2,
  maxTeamSize: 4,
};

describe("findTeamGapFillers", () => {
  it("identifies unmet requirements and recommends candidate that fills the largest gap", () => {
    // Current team only has frontend
    const team: Team = {
      teamId: "team-1",
      name: "Frontend Masters",
      memberIds: ["p1"],
      submittedAt: new Date().toISOString(),
    };

    const teamProfiles: PersonProfile[] = [
      {
        personId: "p1",
        displayName: "Alice",
        skills: [
          { id: "frontend", level: 4, effective: 4, confidence: "high", evidence: [], thought: "" },
        ],
        novelty: 0,
        flags: [],
      },
    ];

    const candidates = [
      {
        personId: "c_back",
        name: "Bob Backend",
        skills: [{ id: "backend", level: 4, effective: 4, confidence: "high", evidence: [] }],
      },
      {
        personId: "c_more_front",
        name: "Charlie Frontend",
        skills: [{ id: "frontend", level: 3, effective: 3, confidence: "high", evidence: [] }],
      },
      {
        personId: "c_ai",
        name: "David AI",
        skills: [{ id: "ai_ml", level: 3, effective: 3, confidence: "high", evidence: [] }],
      },
    ];

    const analysis = findTeamGapFillers(team, teamProfiles, candidates, sampleParams);

    expect(analysis.teamId).toBe("team-1");
    // Unmet requirements should include backend and ai_ml
    expect(analysis.unmetRequirements.map((u) => u.skill)).toEqual(["backend", "ai_ml"]);

    // Bob Backend or David AI should give highest gain (Bob has weight 1 target 4 vs target 3)
    expect(analysis.suggestedCandidates.length).toBeGreaterThan(0);
    const topSuggestion = analysis.suggestedCandidates[0];
    expect(topSuggestion?.candidate.personId).toBe("c_back");
    expect(topSuggestion?.coveredRequirements).toContain("backend");
    expect(topSuggestion?.scoreGain).toBeGreaterThan(0);
  });

  it("returns no suggestions if team is already at max capacity", () => {
    const team: Team = {
      teamId: "full-team",
      name: "Full Team",
      memberIds: ["p1", "p2", "p3", "p4"],
      submittedAt: new Date().toISOString(),
    };

    const teamProfiles: PersonProfile[] = [
      { personId: "p1", displayName: "1", skills: [], novelty: 0, flags: [] },
      { personId: "p2", displayName: "2", skills: [], novelty: 0, flags: [] },
      { personId: "p3", displayName: "3", skills: [], novelty: 0, flags: [] },
      { personId: "p4", displayName: "4", skills: [], novelty: 0, flags: [] },
    ];

    const candidates = [
      {
        personId: "c1",
        name: "Extra",
        skills: [{ id: "backend", level: 5, effective: 5, confidence: "high", evidence: [] }],
      },
    ];

    const analysis = findTeamGapFillers(team, teamProfiles, candidates, sampleParams);
    expect(analysis.suggestedCandidates).toHaveLength(0);
  });
});

describe("autoFormTeams", () => {
  it("combines complementary solo applicants into balanced teams", () => {
    const soloApplicants = [
      {
        personId: "solo_back_1",
        name: "Backend Pro 1",
        skills: [{ id: "backend", level: 4, effective: 4, confidence: "high", evidence: [] }],
      },
      {
        personId: "solo_front_1",
        name: "Frontend Pro 1",
        skills: [{ id: "frontend", level: 4, effective: 4, confidence: "high", evidence: [] }],
      },
      {
        personId: "solo_ai_1",
        name: "AI Pro 1",
        skills: [{ id: "ai_ml", level: 4, effective: 4, confidence: "high", evidence: [] }],
      },
      {
        personId: "solo_back_2",
        name: "Backend Pro 2",
        skills: [{ id: "backend", level: 3, effective: 3, confidence: "high", evidence: [] }],
      },
      {
        personId: "solo_front_2",
        name: "Frontend Pro 2",
        skills: [{ id: "frontend", level: 3, effective: 3, confidence: "high", evidence: [] }],
      },
    ];

    const result = autoFormTeams(soloApplicants, sampleParams, {
      targetTeamSize: 3,
      teamNamePrefix: "Synergy Squad",
    });

    expect(result.formedTeams.length).toBeGreaterThanOrEqual(1);
    const firstTeam = result.formedTeams[0];
    expect(firstTeam?.members.length).toBe(3);
    // Team 1 should have high score due to complementary backend, frontend, ai
    expect(firstTeam?.score).toBeGreaterThan(60);
    expect(firstTeam?.coveredSkillsCount).toBeGreaterThanOrEqual(2);

    // Remaining candidates in second team or unassigned
    const totalProcessed =
      result.formedTeams.reduce((sum, t) => sum + t.members.length, 0) +
      result.unassignedCandidates.length;
    expect(totalProcessed).toBe(soloApplicants.length);
  });

  it("handles empty applicant pools gracefully", () => {
    const result = autoFormTeams([], sampleParams);
    expect(result.formedTeams).toHaveLength(0);
    expect(result.unassignedCandidates).toHaveLength(0);
  });
});
