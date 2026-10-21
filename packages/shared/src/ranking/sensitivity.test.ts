import { describe, expect, it } from "vitest";
import type { PersonProfile, RankingParams, Team } from "../schemas.js";
import { sensitivity } from "./sensitivity.js";

function profile(personId: string, level: number): PersonProfile {
  return {
    personId,
    displayName: personId,
    skills: [
      { id: "backend", level, confidence: "high", effective: level, evidence: [], thought: "" },
    ],
    novelty: 0,
    flags: [],
  };
}

function team(teamId: string, memberIds: string[]): Team {
  return { teamId, name: teamId, memberIds, submittedAt: "2026-01-01T00:00:00.000Z" };
}

const params: RankingParams = {
  requirements: [{ skill: "backend", target: 3, weight: 2, coverage: { mode: "any_member" } }],
  alpha: 0.7,
  noveltyWeight: 10,
  confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
  minFit: 0,
  minTeamSize: 1,
  maxTeamSize: 6,
};

describe("sensitivity", () => {
  it("is deterministic: same seed produces identical results", () => {
    const profiles = [profile("p1", 4), profile("p2", 2)];
    const teams = [team("t1", ["p1"]), team("t2", ["p2"])];
    const r1 = sensitivity(profiles, teams, params, { seed: 7, perturbations: 20 });
    const r2 = sensitivity(profiles, teams, params, { seed: 7, perturbations: 20 });
    expect(r1).toEqual(r2);
  });

  it("different seeds produce reproducible results and run perturbations", () => {
    const profiles = [
      profile("p1", 3),
      profile("p2", 3.1),
      profile("p3", 2.9),
      profile("p4", 3.05),
    ];
    const teams = [team("t1", ["p1"]), team("t2", ["p2"]), team("t3", ["p3"]), team("t4", ["p4"])];
    const r1 = sensitivity(profiles, teams, params, { seed: 1, perturbations: 40 });
    const r2 = sensitivity(profiles, teams, params, { seed: 99999, perturbations: 40 });
    expect(r1.seed).toBe(1);
    expect(r2.seed).toBe(99999);
    expect(r1.teams.length).toBe(4);
    expect(r2.teams.length).toBe(4);
  });

  it("the top-skilled team is always stable at rank 1", () => {
    const profiles = [profile("best", 5), profile("weak", 1)];
    const teams = [team("t1", ["best"]), team("t2", ["weak"])];
    const result = sensitivity(profiles, teams, params, { perturbations: 50 });
    const best = result.teams.find((t) => t.teamId === "t1");
    expect(best?.minRank).toBe(1);
    expect(best?.maxRank).toBe(1);
    expect(best?.stability).toBe("stable");
  });

  it("returns null ranks for a team that is always ineligible", () => {
    const profiles = [profile("p1", 4), profile("ineligible", 1)];
    const teams = [team("eligible", ["p1"]), team("toobig", ["ineligible", "p1"])];
    // Set maxTeamSize: 1 so toobig (with 2 members) is always ineligible
    const strictParams: RankingParams = { ...params, minTeamSize: 1, maxTeamSize: 1 };
    const result = sensitivity(profiles, teams, strictParams, { perturbations: 10 });
    const toobig = result.teams.find((t) => t.teamId === "toobig");
    expect(toobig?.minRank).toBe(null);
    expect(toobig?.maxRank).toBe(null);
    expect(toobig?.stability).toBe("stable");
  });

  it("caps perturbations at 200", () => {
    const profiles = [profile("p1", 3)];
    const teams = [team("t1", ["p1"])];
    const result = sensitivity(profiles, teams, params, { perturbations: 9999 });
    expect(result.perturbations).toBe(200);
  });

  it("returns the correct seed in the result", () => {
    const profiles = [profile("p1", 3)];
    const teams = [team("t1", ["p1"])];
    const result = sensitivity(profiles, teams, params, { seed: 123, perturbations: 5 });
    expect(result.seed).toBe(123);
  });

  it("handles a single team", () => {
    const profiles = [profile("p1", 3)];
    const teams = [team("t1", ["p1"])];
    const result = sensitivity(profiles, teams, params, { perturbations: 10 });
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]?.teamId).toBe("t1");
    expect(result.teams[0]?.minRank).toBe(1);
    expect(result.teams[0]?.maxRank).toBe(1);
  });
});
