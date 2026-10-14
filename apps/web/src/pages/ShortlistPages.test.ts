import { type PersonProfile, type RankingParams, rank, type Team } from "@talentradar/shared";
import { expect, test } from "vitest";
import type { OrganizerShortlistRun } from "../lib/api";
import { explainTeam, whatIfRank, withIneligibleNotes } from "./ShortlistPages";

const person = (
  personId: string,
  novelty: number,
  skills: Array<[string, number]>,
): PersonProfile => ({
  personId,
  displayName: personId,
  novelty,
  flags: [],
  skills: skills.map(([id, level]) => ({
    id,
    level,
    effective: level,
    confidence: "high",
    evidence: [],
    thought: "",
  })),
});

// The spec's worked example (Shortlisting algorithm).
const profiles = [
  person("Riya", 0.25, [
    ["ai_ml", 3.6],
    ["backend", 1.5],
  ]),
  person("Kabir", 0, [
    ["backend", 3.2],
    ["frontend", 2.4],
  ]),
  person("Meera", 0, [
    ["frontend", 1.8],
    ["design_ui_ux", 2.5],
  ]),
  person("Arjun", 0.25, [
    ["ai_ml", 4.5],
    ["backend", 3.8],
    ["frontend", 3],
  ]),
  person("Sana", 0, [["ai_ml", 4.1]]),
  person("Dev", 0, [["ai_ml", 3.9]]),
];
const teams: Team[] = [
  {
    teamId: "alpha",
    name: "Team Alpha",
    memberIds: ["Riya", "Kabir", "Meera"],
    submittedAt: "2026-10-10T10:00:00.000Z",
  },
  {
    teamId: "beta",
    name: "Team Beta",
    memberIds: ["Arjun", "Sana", "Dev"],
    submittedAt: "2026-10-10T10:01:00.000Z",
  },
];
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
  maxTeamSize: 4,
};

test("with design weight 0, Team Beta overtakes Team Alpha", () => {
  expect(whatIfRank(profiles, teams, params, "beta", "ai_ml")).toBe(2);
  expect(whatIfRank(profiles, teams, params, "beta", "design_ui_ux")).toBe(1);
});

test("an imported person with no team is ineligible, and the explanation says why", () => {
  const solo: Team = {
    teamId: "solo",
    name: "No team — Sana",
    memberIds: ["Sana"],
    submittedAt: "2026-10-10T10:02:00.000Z",
  };
  const note = "No team: registered without a team name";
  const [ranked] = withIneligibleNotes(rank(profiles, [solo], { ...params, minTeamSize: 2 }), {
    solo: note,
  });
  expect(ranked?.ineligibleReasons[0]).toBe(note);
  if (!ranked) throw new Error("solo team was not ranked");
  const result = {
    ...ranked,
    name: solo.name,
    memberIds: solo.memberIds,
    status: "ineligible" as const,
    waitlistPosition: null,
    borderline: false,
  };
  const run = {
    params,
    selection: { cutoffScore: null },
    results: [result],
  } as unknown as OrganizerShortlistRun;
  expect(explainTeam(result, run, new Map())[0]).toMatch(/^Ineligible: no team: registered/);
});
