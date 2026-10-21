import { describe, expect, it } from "vitest";
import type { PersonProfile, RankingParams, Team } from "../schemas.js";
import { RankingParamsSchema } from "../schemas.js";
import {
  workedExampleParams,
  workedExampleProfiles,
  workedExampleTeams,
} from "./__tests__/fixtures.js";
import { DEFAULT_NOVELTY_MAX_SHARE, rank } from "./rank.js";

function skill(id: string, level: number) {
  return {
    id,
    level,
    confidence: "high" as const,
    effective: level,
    evidence: [],
    thought: "",
  };
}

function person(id: string, skills: Array<[string, number]>, novelty = 0): PersonProfile {
  return {
    personId: id,
    displayName: id,
    skills: skills.map(([name, level]) => skill(name, level)),
    novelty,
    flags: [],
  };
}

const team = (id: string, memberIds: string[]): Team => ({
  teamId: id,
  name: id,
  memberIds,
  submittedAt: "2026-10-10T10:00:00.000Z",
});

const requirement = (skillId: string, target = 3, weight = 1) => ({
  skill: skillId,
  target,
  weight,
  coverage: { mode: "any_member" as const },
});

const scoreOf = (profiles: PersonProfile[], teams: Team[], params: RankingParams, id: string) => {
  const found = rank(profiles, teams, params).find((candidate) => candidate.teamId === id);
  if (!found) throw new Error("team missing");
  return found;
};

describe("team novelty blend", () => {
  const profiles = [person("a", [["ai_ml", 3]], 1), person("b", [["ai_ml", 3]], 0.5)];
  const params: RankingParams = {
    requirements: [requirement("ai_ml")],
    alpha: 0.7,
    noveltyWeight: 20,
    confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
    minFit: 0,
    minTeamSize: 1,
    maxTeamSize: 6,
  };

  it("defaults to half the best member plus half the mean of the top two", () => {
    expect(DEFAULT_NOVELTY_MAX_SHARE).toBe(0.5);
    const result = scoreOf(profiles, [team("t", ["a", "b"])], params, "t");
    expect(result.novelty).toBeCloseTo(0.5 * 1 + 0.5 * 0.75, 9);
  });

  it("noveltyMaxShare 1 restores the old max-member rule", () => {
    const result = scoreOf(
      profiles,
      [team("t", ["a", "b"])],
      { ...params, noveltyMaxShare: 1 },
      "t",
    );
    expect(result.novelty).toBe(1);
  });

  it("a one-member team uses that member's novelty", () => {
    expect(scoreOf(profiles, [team("t", ["b"])], params, "t").novelty).toBe(0.5);
  });

  it("keeps the novelty weight cap at 25", () => {
    expect(RankingParamsSchema.safeParse({ ...params, noveltyWeight: 26 }).success).toBe(false);
  });
});

describe("team synergy", () => {
  const base: RankingParams = {
    requirements: [requirement("ai_ml"), requirement("frontend"), requirement("backend")],
    alpha: 0.7,
    noveltyWeight: 0,
    confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
    minFit: 0,
    minTeamSize: 1,
    maxTeamSize: 6,
  };
  const balanced = [
    person("m1", [["ai_ml", 4]]),
    person("m2", [["frontend", 4]]),
    person("m3", [["backend", 4]]),
  ];
  const stacked = [
    person("s1", [["ai_ml", 4]]),
    person("s2", [["ai_ml", 4]]),
    person("s3", [["ai_ml", 4]]),
  ];

  it("defaults to zero weight: the score ignores synergy but still reports it", () => {
    const result = scoreOf(balanced, [team("t", ["m1", "m2", "m3"])], base, "t");
    const withZero = scoreOf(
      balanced,
      [team("t", ["m1", "m2", "m3"])],
      { ...base, synergyWeight: 0 },
      "t",
    );
    expect(withZero.score).toBe(result.score);
    expect(result.synergy?.score).toBe(1);
  });

  it("rewards a role-balanced team and penalises a team strong in one shared domain", () => {
    const params = { ...base, synergyWeight: 10 };
    const good = scoreOf(balanced, [team("t", ["m1", "m2", "m3"])], params, "t");
    expect(good.synergy).toMatchObject({
      balance: 1,
      redundancy: 0,
      score: 1,
      points: 10,
      uncoveredDomains: [],
    });
    const bad = scoreOf(stacked, [team("t", ["s1", "s2", "s3"])], params, "t");
    expect(bad.synergy).toMatchObject({
      redundancy: 1,
      redundantDomain: "ai_ml",
      uncoveredDomains: ["backend", "frontend"],
      score: 0,
      points: 0,
    });
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it("keeps scores within 0..100 when synergy takes its share", () => {
    const strong = [
      person(
        "x",
        [
          ["ai_ml", 5],
          ["frontend", 5],
          ["backend", 5],
        ],
        1,
      ),
    ];
    const result = scoreOf(
      strong,
      [team("t", ["x"])],
      { ...base, noveltyWeight: 25, synergyWeight: 15 },
      "t",
    );
    expect(result.score).toBeLessThanOrEqual(100 + 1e-9);
    expect(result.score).toBeCloseTo(100, 6);
  });

  it("validates the 0..15 range and stays optional for saved events", () => {
    expect(RankingParamsSchema.safeParse({ ...base, synergyWeight: 16 }).success).toBe(false);
    expect(RankingParamsSchema.safeParse({ ...base, synergyWeight: -1 }).success).toBe(false);
    expect(RankingParamsSchema.safeParse(base).success).toBe(true);
  });

  it("maps a tool requirement to its taxonomy domains", () => {
    const params: RankingParams = {
      ...base,
      requirements: [requirement("react"), requirement("pytorch")],
      synergyWeight: 5,
    };
    const result = scoreOf(
      [person("r", [["react", 4]]), person("p", [["pytorch", 4]])],
      [team("t", ["r", "p"])],
      params,
      "t",
    );
    expect(result.synergy?.coveredDomains.length).toBeGreaterThanOrEqual(2);
  });
});

/** Small seeded generator so property tests are reproducible. */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKILLS = ["ai_ml", "backend", "frontend", "design_ui_ux", "react", "python"];

function randomScenario(random: () => number) {
  const people = Array.from({ length: 6 }, (_, index) =>
    person(
      `p${index}`,
      SKILLS.filter(() => random() < 0.6).map((id): [string, number] => [
        id,
        Math.round((1 + random() * 4) * 10) / 10,
      ]),
      random(),
    ),
  );
  const teams = [team("a", ["p0", "p1", "p2"]), team("b", ["p3", "p4", "p5"])];
  const params: RankingParams = {
    requirements: SKILLS.slice(0, 4).map((id) => ({
      skill: id,
      target: 1 + Math.floor(random() * 8) / 2,
      weight: 1 + Math.floor(random() * 5),
      coverage:
        random() < 0.5
          ? { mode: "any_member" as const }
          : { mode: "min_members" as const, minMembers: 2 },
    })),
    alpha: random(),
    noveltyWeight: Math.floor(random() * 26),
    confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
    noveltyMaxShare: random(),
    minFit: 0,
    minTeamSize: 1,
    maxTeamSize: 6,
  };
  return { people, teams, params };
}

describe("ranking properties", () => {
  it("is deterministic: the same input gives identical output, in any input order", () => {
    const random = mulberry32(7);
    for (let run = 0; run < 50; run++) {
      const { people, teams, params } = randomScenario(random);
      const first = rank(people, teams, params);
      expect(rank(people, teams, params)).toEqual(first);
      expect(rank([...people].reverse(), teams, params)).toEqual(first);
    }
  });

  it("is monotone: a better skill or higher novelty never lowers a team's score", () => {
    const random = mulberry32(42);
    for (let run = 0; run < 300; run++) {
      const { people, teams, params } = randomScenario(random);
      const before = rank(people, teams, params);
      const index = Math.floor(random() * people.length);
      const target = people[index];
      if (!target) continue;
      const skillId = SKILLS[Math.floor(random() * SKILLS.length)] ?? "ai_ml";
      const existing = target.skills.find((candidate) => candidate.id === skillId);
      const improved: PersonProfile = {
        ...target,
        novelty: Math.min(1, target.novelty + random() * 0.3),
        skills: existing
          ? target.skills.map((candidate) =>
              candidate.id === skillId
                ? { ...candidate, level: Math.min(5, candidate.level + random() * 2) }
                : candidate,
            )
          : [...target.skills, skill(skillId, 1 + random() * 4)],
      };
      const after = rank(
        people.map((candidate, i) => (i === index ? improved : candidate)),
        teams,
        params,
      );
      for (const old of before) {
        const next = after.find((candidate) => candidate.teamId === old.teamId);
        expect(next?.score ?? 0).toBeGreaterThanOrEqual(old.score - 1e-9);
      }
    }
  });

  it("keeps every score within 0..100 including synergy", () => {
    const random = mulberry32(99);
    for (let run = 0; run < 100; run++) {
      const { people, teams, params } = randomScenario(random);
      const withSynergy = { ...params, synergyWeight: Math.floor(random() * 16) };
      for (const result of rank(people, teams, withSynergy)) {
        expect(result.score).toBeGreaterThanOrEqual(-1e-9);
        expect(result.score).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
  });
});

describe("backwards compatibility", () => {
  it("a saved event without the new params still parses and scores with documented defaults", () => {
    const { noveltyMaxShare: _legacy, ...saved } = workedExampleParams;
    expect(RankingParamsSchema.safeParse(saved).success).toBe(true);
    const results = rank(workedExampleProfiles, workedExampleTeams, saved);
    // Team Alpha's best member has novelty 0.25; with the blend the default still gives
    // 0.5 * 0.25 + 0.5 * mean(0.25, 0) = 0.1875 for Beta (was 0.25).
    expect(results.find((result) => result.teamId === "beta")?.novelty).toBeCloseTo(0.1875, 9);
    expect(results.find((result) => result.teamId === "beta")?.synergy?.points).toBe(0);
  });
});
