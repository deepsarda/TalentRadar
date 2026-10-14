import { describe, expect, it } from "vitest";
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

function team(teamId: string, size: number, college = "SVNIT Surat"): SelectionTeam {
  const members = Array.from({ length: size }, (_, index) => ({
    personId: `${teamId}-${index}`,
    college,
  }));
  return {
    teamId,
    name: `Team ${teamId}`,
    memberIds: members.map((member) => member.personId),
    members,
  };
}

describe("selectShortlist", () => {
  it("fills participant seats in rank order and skips a team that does not fit", () => {
    const decision = selectShortlist(
      [ranked("a", 1, 90), ranked("b", 2, 80), ranked("c", 3, 70)],
      [team("a", 3), team("b", 2), team("c", 1)],
      { capacity: 4, waitlistSize: 1 },
    );

    expect(decision.selectedSeats).toBe(4);
    expect(decision.results.map((result) => [result.teamId, result.status])).toEqual([
      ["a", "selected"],
      ["b", "waitlisted"],
      ["c", "selected"],
    ]);
  });

  it("swaps the lowest non-helping selection to meet a team quota", () => {
    const decision = selectShortlist(
      [ranked("a", 1, 90), ranked("b", 2, 80), ranked("c", 3, 70)],
      [team("a", 2), team("b", 2), team("c", 2, "Outside College")],
      {
        capacity: 4,
        waitlistSize: 1,
        quotas: [
          {
            attribute: "college",
            op: "not_equals",
            value: "SVNIT Surat",
            minShare: 0.5,
            unit: "teams",
            match: "all",
          },
        ],
      },
    );

    expect(decision.results.find((result) => result.teamId === "c")?.status).toBe("selected");
    expect(decision.results.find((result) => result.teamId === "b")?.status).toBe("waitlisted");
    expect(decision.swaps).toHaveLength(1);
    expect(decision.quotaReports[0]?.met).toBe(true);
  });

  it("requires a reason and honours pin-in and pin-out overrides", () => {
    const rankedTeams = [ranked("a", 1, 90), ranked("b", 2, 80)];
    const teams = [team("a", 2), team("b", 2)];
    const decision = selectShortlist(rankedTeams, teams, {
      capacity: 2,
      waitlistSize: 0,
      overrides: [
        { teamId: "a", action: "pin_out", reason: "Conflict of interest" },
        { teamId: "b", action: "pin_in", reason: "Manual evidence review" },
      ],
    });

    expect(decision.results.find((result) => result.teamId === "a")?.status).toBe("not_selected");
    expect(decision.results.find((result) => result.teamId === "b")?.status).toBe("selected");
    expect(() =>
      selectShortlist(rankedTeams, teams, {
        capacity: 2,
        waitlistSize: 0,
        overrides: [{ teamId: "a", action: "pin_out", reason: " " }],
      }),
    ).toThrow("reason");
  });

  it("tries the next helpful team when the highest-scoring swap does not fit", () => {
    const decision = selectShortlist(
      [ranked("a", 1, 90), ranked("b", 2, 80), ranked("c", 3, 70), ranked("d", 4, 60)],
      [
        team("a", 2),
        team("b", 2),
        team("c", 3, "Outside College"),
        team("d", 2, "Outside College"),
      ],
      {
        capacity: 4,
        waitlistSize: 1,
        quotas: [
          {
            attribute: "college",
            op: "not_equals",
            value: "SVNIT Surat",
            minShare: 0.5,
            unit: "teams",
            match: "all",
          },
        ],
      },
    );

    expect(decision.results.find((result) => result.teamId === "c")?.status).not.toBe("selected");
    expect(decision.results.find((result) => result.teamId === "d")?.status).toBe("selected");
    expect(decision.quotaReports[0]?.met).toBe(true);
  });
});
