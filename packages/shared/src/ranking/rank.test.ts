import { describe, expect, it } from "vitest";
import {
  workedExampleParams,
  workedExampleProfiles,
  workedExampleTeams,
} from "./__tests__/fixtures.js";
import { rank } from "./rank.js";

describe("rank", () => {
  it("reproduces the worked example from the product specification", () => {
    const results = rank(workedExampleProfiles, workedExampleTeams, workedExampleParams);
    const alpha = results.find((team) => team.teamId === "alpha");
    const beta = results.find((team) => team.teamId === "beta");

    expect(alpha?.fit).toBeCloseTo(1, 6);
    expect(alpha?.score).toBeCloseTo(82.0375, 4);
    expect(alpha?.rank).toBe(1);
    expect(beta?.fit).toBeCloseTo(0.875, 6);
    expect(beta?.score).toBeCloseTo(75.9175, 4);
    expect(beta?.rank).toBe(2);
  });

  it("reranks without mutating profiles when design has no weight", () => {
    const profilesBefore = JSON.stringify(workedExampleProfiles);
    const params = {
      ...workedExampleParams,
      requirements: workedExampleParams.requirements.map((requirement) => ({
        ...requirement,
        weight: requirement.skill === "design_ui_ux" ? 0 : requirement.weight,
      })),
    };

    const results = rank(workedExampleProfiles, workedExampleTeams, params);

    expect(results[0]?.teamId).toBe("beta");
    expect(results[0]?.score).toBeCloseTo(86.4057, 4);
    expect(results[1]?.score).toBeCloseTo(82.4714, 4);
    expect(JSON.stringify(workedExampleProfiles)).toBe(profilesBefore);
  });

  it("applies the novelty bonus once per team", () => {
    const profiles = workedExampleProfiles.map((profile) =>
      profile.personId === "arjun" ? { ...profile, novelty: 1 } : profile,
    );

    const beta = rank(profiles, workedExampleTeams, workedExampleParams).find(
      (team) => team.teamId === "beta",
    );

    expect(beta?.score).toBeCloseTo(83.4175, 4);
  });

  it("uses the nth-best member for minimum-member coverage", () => {
    const params = {
      ...workedExampleParams,
      requirements: [
        {
          skill: "ai_ml",
          target: 4,
          weight: 1,
          coverage: { mode: "min_members" as const, minMembers: 2 },
        },
      ],
    };

    const beta = rank(workedExampleProfiles, workedExampleTeams, params).find(
      (team) => team.teamId === "beta",
    );

    expect(beta?.breakdown[0]?.teamLevel).toBe(4.1);
    expect(beta?.breakdown[0]?.bestMemberId).toBe("sana");
  });

  it("marks teams below the minimum fit as ineligible", () => {
    const params = { ...workedExampleParams, minFit: 0.9 };
    const beta = rank(workedExampleProfiles, workedExampleTeams, params).find(
      (team) => team.teamId === "beta",
    );

    expect(beta?.eligible).toBe(false);
    expect(beta?.rank).toBeNull();
    expect(beta?.ineligibleReasons).toContain("Team fit is below 90%");
  });

  it("reranks cached raw levels with the run confidence factors", () => {
    const profiles = workedExampleProfiles.map((profile) =>
      profile.personId === "arjun"
        ? {
            ...profile,
            skills: profile.skills.map((skill) => ({ ...skill, confidence: "low" as const })),
          }
        : profile,
    );
    const strict = rank(profiles, workedExampleTeams, {
      ...workedExampleParams,
      confidenceFactors: { high: 1, medium: 0.85, low: 0.4 },
    });
    const lenient = rank(profiles, workedExampleTeams, {
      ...workedExampleParams,
      confidenceFactors: { high: 1, medium: 0.85, low: 1 },
    });

    expect(strict.find((team) => team.teamId === "beta")?.score).toBeLessThan(
      lenient.find((team) => team.teamId === "beta")?.score ?? 0,
    );
  });
});
