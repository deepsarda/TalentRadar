import { describe, expect, it } from "vitest";
import { optimizeShortlist } from "./optimizer.js";
import type { RankedTeam } from "./rank.js";
import { type SelectionTeam, selectShortlist } from "./select.js";

function ranked(teamId: string, rank: number, score: number): RankedTeam {
  return {
    teamId,
    rank,
    eligible: true,
    ineligibleReasons: [],
    score,
    fit: score / 100,
    depth: score / 100,
    novelty: 0,
    submittedAt: `2026-01-0${rank}T00:00:00.000Z`,
    breakdown: [],
  };
}

function team(teamId: string, size: number, college = "SVNIT"): SelectionTeam {
  const members = Array.from({ length: size }, (_, i) => ({ personId: `${teamId}-${i}`, college }));
  return { teamId, name: `Team ${teamId}`, memberIds: members.map((m) => m.personId), members };
}

const quota = {
  attribute: "college" as const,
  op: "not_equals" as const,
  value: "SVNIT",
  minShare: 0.5,
  unit: "teams" as const,
  match: "all" as const,
};

describe("optimizeShortlist", () => {
  it("optimizer result is never worse than greedy (no quotas)", () => {
    const teams = [ranked("a", 1, 90), ranked("b", 2, 80), ranked("c", 3, 70)];
    const rawTeams = [team("a", 2), team("b", 2), team("c", 2)];
    const params = { capacity: 4, waitlistSize: 0 };
    const greedy = selectShortlist(teams, rawTeams, params);
    const optimized = optimizeShortlist(teams, rawTeams, params);
    const greedyScore = greedy.results
      .filter((r) => r.status === "selected")
      .reduce((s, r) => s + r.score, 0);
    const optimizedScore = optimized.results
      .filter((r) => r.status === "selected")
      .reduce((s, r) => s + r.score, 0);
    expect(optimizedScore).toBeGreaterThanOrEqual(greedyScore);
  });

  it("optimizer never produces a worse result than greedy with quotas", () => {
    const teams = [ranked("a", 1, 90), ranked("b", 2, 80), ranked("c", 3, 70)];
    const rawTeams = [team("a", 2, "SVNIT"), team("b", 2, "SVNIT"), team("c", 2, "Outside")];
    const params = { capacity: 4, waitlistSize: 0, quotas: [quota] };
    const greedy = selectShortlist(teams, rawTeams, params);
    const optimized = optimizeShortlist(teams, rawTeams, params);
    const greedyScore = greedy.results
      .filter((r) => r.status === "selected")
      .reduce((s, r) => s + r.score, 0);
    const optimizedScore = optimized.results
      .filter((r) => r.status === "selected")
      .reduce((s, r) => s + r.score, 0);
    expect(optimizedScore).toBeGreaterThanOrEqual(greedyScore);
  });

  it("respects pin_in and pin_out overrides", () => {
    const teams = [ranked("a", 1, 90), ranked("b", 2, 80)];
    const rawTeams = [team("a", 2), team("b", 2)];
    const params = {
      capacity: 2,
      waitlistSize: 0,
      overrides: [
        { teamId: "a", action: "pin_out" as const, reason: "Conflict" },
        { teamId: "b", action: "pin_in" as const, reason: "Manual" },
      ],
    };
    const result = optimizeShortlist(teams, rawTeams, params);
    expect(result.results.find((r) => r.teamId === "a")?.status).toBe("not_selected");
    expect(result.results.find((r) => r.teamId === "b")?.status).toBe("selected");
  });

  it("marks optimized:true when no quotas (greedy is provably optimal)", () => {
    const teams = [ranked("a", 1, 90)];
    const rawTeams = [team("a", 2)];
    const result = optimizeShortlist(teams, rawTeams, { capacity: 2, waitlistSize: 0 });
    expect(result.optimized).toBe(true);
  });

  it("sets optimizerNote for no-quota case", () => {
    const teams = [ranked("a", 1, 90)];
    const rawTeams = [team("a", 2)];
    const result = optimizeShortlist(teams, rawTeams, { capacity: 2, waitlistSize: 0 });
    expect(result.optimizerNote).toBeTruthy();
  });

  it("quota reports explain satisfaction", () => {
    const teams = [ranked("a", 1, 90), ranked("b", 2, 80), ranked("c", 3, 70)];
    const rawTeams = [team("a", 2, "SVNIT"), team("b", 2, "SVNIT"), team("c", 2, "Outside")];
    const params = { capacity: 4, waitlistSize: 0, quotas: [quota] };
    const result = optimizeShortlist(teams, rawTeams, params);
    expect(result.quotaReports).toHaveLength(1);
    expect(result.quotaReports[0]?.message).toBeTruthy();
  });
});
