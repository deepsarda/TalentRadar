import type { DecidedTeam, RankingParams } from "@talentradar/shared";
import { describe, expect, it } from "vitest";
import type { OrganizerShortlistRun } from "./api.js";
import { compareRuns } from "./compare-runs.js";

const defaultParams: RankingParams = {
  requirements: [{ skill: "backend", target: 3, weight: 3, coverage: { mode: "any_member" } }],
  alpha: 0.7,
  noveltyWeight: 10,
  confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
  minFit: 0,
  minTeamSize: 1,
  maxTeamSize: 4,
};

function createMockTeam(
  id: string,
  name: string,
  rank: number,
  score: number,
  status: DecidedTeam["status"],
): DecidedTeam {
  return {
    teamId: id,
    name,
    rank,
    score,
    status,
    fit: score / 10,
    depth: 0,
    novelty: 0,
    eligible: true,
    ineligibleReasons: [],
    breakdown: [],
    memberIds: [`p_${id}`],
    submittedAt: "2026-10-19T10:00:00Z",
    borderline: false,
    waitlistPosition: status === "waitlisted" ? 1 : null,
  };
}

describe("compareRuns", () => {
  it("detects teams that moved in and out between two runs", () => {
    const runA: OrganizerShortlistRun = {
      id: "run-1",
      hackathonId: "hack-1",
      name: "Run A",
      params: defaultParams,
      selection: { capacity: 10, waitlistSize: 5, quotas: [], selectedSeats: 5, cutoffScore: 50 },
      results: [
        createMockTeam("t1", "Team 1", 1, 80, "selected"),
        createMockTeam("t2", "Team 2", 2, 60, "selected"),
        createMockTeam("t3", "Team 3", 3, 40, "not_selected"),
      ],
      swaps: [],
      quotaReports: [],
      overrides: [],
      published: false,
      createdAt: "2026-10-19T10:00:00Z",
      snapshot: null,
    };

    const runB: OrganizerShortlistRun = {
      id: "run-2",
      hackathonId: "hack-1",
      name: "Run B",
      params: {
        ...defaultParams,
        requirements: [
          { skill: "backend", target: 3, weight: 5, coverage: { mode: "any_member" } },
        ],
      },
      selection: { capacity: 10, waitlistSize: 5, quotas: [], selectedSeats: 5, cutoffScore: 50 },
      results: [
        createMockTeam("t1", "Team 1", 1, 90, "selected"),
        createMockTeam("t3", "Team 3", 2, 70, "selected"), // moved in!
        createMockTeam("t2", "Team 2", 3, 30, "not_selected"), // moved out!
      ],
      swaps: [],
      quotaReports: [],
      overrides: [],
      published: false,
      createdAt: "2026-10-19T11:00:00Z",
      snapshot: null,
    };

    const diff = compareRuns(runA, runB);

    expect(diff.movedIn.map((t) => t.teamId)).toEqual(["t3"]);
    expect(diff.movedOut.map((t) => t.teamId)).toEqual(["t2"]);
    expect(diff.parameterChanges).toContain('Weight for "backend" changed from ×3 to ×5');
  });
});
