import { describe, expect, it } from "vitest";
import {
  aggregateProfile,
  MAX_UPSTREAM_BONUS,
  type ProfileJudgment,
  RECENCY_FLOOR,
  recencyFactor,
  SKILL_AVERAGE_SHARE,
  SKILL_TOP_SHARE,
  UNANALYSED_NOTE,
  upstreamBonus,
  withDetectedTools,
} from "./aggregate.js";

describe("aggregateProfile", () => {
  it("reproduces the specification's weighted PyTorch example", () => {
    const evidence = [{ path: "train.py", note: "Training loop" }];
    const judgment: ProfileJudgment = {
      thoughts: "",
      summary: "ML student",
      flags: [],
      cv: { claims: [] },
      repos: [
        {
          repo: "riya/crop-disease-api",
          commitSha: "a123456",
          pushedAt: "2026-09-01T00:00:00Z",
          authorship: 0.9,
          originality: 4,
          skills: [{ id: "pytorch", evidence, thought: "Strong custom loop", level: 4 }],
        },
        {
          repo: "riya/mnist-tutorial",
          commitSha: "b123456",
          pushedAt: "2026-08-01T00:00:00Z",
          authorship: 1,
          originality: 2,
          skills: [{ id: "pytorch", evidence, thought: "Tutorial work", level: 2 }],
        },
        {
          repo: "riya/leaf-segmentation",
          commitSha: "c123456",
          pushedAt: "2026-07-01T00:00:00Z",
          authorship: 0.8,
          originality: 4,
          skills: [{ id: "pytorch", evidence, thought: "Original segmentation", level: 3 }],
        },
      ],
    };

    const profile = aggregateProfile("riya", "Riya", judgment, new Date("2026-10-13T00:00:00Z"));
    expect(profile.summary).toBe("ML student");
    expect(profile.skills[0]).toMatchObject({
      id: "pytorch",
      // 0.6 * best repository level (4) + 0.4 * weighted average (3.18): was 3.18 before the blend.
      level: 3.68,
      confidence: "high",
      effective: 3.68,
    });
    // Best repository has originality 4 -> (4 - 1) / 4: was the bucket 0.25.
    expect(profile.novelty).toBe(0.75);
  });

  it("keeps a CV-only claim low confidence", () => {
    const profile = aggregateProfile(
      "person",
      "Person",
      {
        thoughts: "",
        summary: "CV only",
        repos: [],
        cv: { claims: [{ id: "figma", quote: "Figma", thought: "No code evidence", level: 2 }] },
        flags: [],
      },
      new Date("2026-10-13T00:00:00Z"),
    );
    expect(profile.skills[0]).toMatchObject({ level: 2, confidence: "low", effective: 1.2 });
  });
});

describe("withDetectedTools", () => {
  const sha = "a".repeat(40);
  const base = {
    personId: "riya",
    displayName: "Riya",
    novelty: 0,
    flags: [],
    skills: [
      {
        id: "python",
        level: 4,
        confidence: "medium" as const,
        effective: 3.4,
        evidence: [],
        thought: "",
      },
    ],
  };

  it("keeps detected tools the model didn't judge at level 3, low confidence, marked unanalysed", () => {
    const profile = withDetectedTools(base, [
      { repository: "riya/app", commitSha: sha, id: "react", reasons: ["npm:react"] },
      { repository: "riya/web", commitSha: sha, id: "react", reasons: ["npm:react"] },
    ]);
    const react = profile.skills.find((skill) => skill.id === "react");
    expect(react).toMatchObject({ level: 3, confidence: "low", effective: 1.8 });
    expect(react?.evidence).toHaveLength(2);
    expect(react?.evidence[0]?.note).toContain(UNANALYSED_NOTE);
  });

  it("never overrides a judged skill, and skips concept-only text matches", () => {
    const profile = withDetectedTools(base, [
      { repository: "riya/app", commitSha: sha, id: "python", reasons: ["language:Python"] },
      { repository: "riya/app", commitSha: sha, id: "accessibility", reasons: ["concepts:aria"] },
    ]);
    expect(profile.skills).toEqual(base.skills);
  });
});

const NOW = new Date("2026-10-13T00:00:00Z");
const evidence = [{ path: "a.py", note: "code" }];

function judgment(
  repos: Array<{ level: number; originality?: number; pushedAt?: string; authorship?: number }>,
): ProfileJudgment {
  return {
    thoughts: "",
    summary: "s",
    flags: [],
    cv: { claims: [] },
    repos: repos.map((repo, index) => ({
      repo: `p/r${index}`,
      commitSha: "a123456",
      pushedAt: repo.pushedAt ?? "2026-10-01T00:00:00Z",
      authorship: repo.authorship ?? 1,
      originality: repo.originality ?? 3,
      skills: [{ id: "python", evidence, thought: "", level: repo.level }],
    })),
  };
}

const levelOf = (profile: ReturnType<typeof aggregateProfile>) => profile.skills[0]?.level;

describe("skill blend", () => {
  it("shares sum to one", () => {
    expect(SKILL_TOP_SHARE + SKILL_AVERAGE_SHARE).toBe(1);
  });

  it("does not drag an expert down to the average of weaker repositories", () => {
    // Equal weights: old plain average = (5 + 1 + 1) / 3 = 2.33; blend = 0.6 * 5 + 0.4 * 2.33.
    const profile = aggregateProfile(
      "p",
      "P",
      judgment([{ level: 5 }, { level: 1 }, { level: 1 }]),
      NOW,
      { recency: () => 1 },
    );
    expect(levelOf(profile)).toBeCloseTo(0.6 * 5 + 0.4 * (7 / 3), 2);
  });

  it("leaves a single repository's level unchanged", () => {
    expect(levelOf(aggregateProfile("p", "P", judgment([{ level: 4 }]), NOW))).toBe(4);
  });

  it("still counts only the three best repositories", () => {
    const withFour = aggregateProfile(
      "p",
      "P",
      judgment([{ level: 4 }, { level: 4 }, { level: 4 }, { level: 1 }]),
      NOW,
      { recency: () => 1 },
    );
    expect(levelOf(withFour)).toBe(4);
  });
});

describe("recencyFactor", () => {
  const at = (years: number) =>
    recencyFactor(new Date(NOW.getTime() - years * 365.25 * 864e5).toISOString(), NOW);

  it("is 1 for fresh or future pushes, decays smoothly and never drops below the floor", () => {
    expect(at(0)).toBe(1);
    expect(recencyFactor("2027-01-01T00:00:00Z", NOW)).toBe(1);
    expect(at(1)).toBeCloseTo(Math.exp(-1 / 3), 6);
    expect(at(10)).toBe(RECENCY_FLOOR);
    // No cliffs: a day either side of the old one- and two-year boundaries barely moves it.
    for (const boundary of [1, 2]) {
      expect(Math.abs(at(boundary - 1 / 365) - at(boundary + 1 / 365))).toBeLessThan(0.01);
    }
    let previous = 2;
    for (let years = 0; years <= 6; years += 0.25) {
      expect(at(years)).toBeLessThanOrEqual(previous);
      previous = at(years);
    }
  });

  it("can be injected so scoring is testable without a clock", () => {
    const old = judgment([{ level: 5, pushedAt: "2020-01-01T00:00:00Z" }, { level: 1 }]);
    const flat = aggregateProfile("p", "P", old, NOW, { recency: () => 1 });
    const real = aggregateProfile("p", "P", old, NOW);
    expect(levelOf(real)).toBeLessThan(levelOf(flat) ?? 0);
  });

  it("is deterministic", () => {
    const input = judgment([{ level: 3 }, { level: 5, pushedAt: "2023-05-05T00:00:00Z" }]);
    expect(aggregateProfile("p", "P", input, NOW)).toEqual(aggregateProfile("p", "P", input, NOW));
  });
});

describe("continuous novelty", () => {
  it("scales originality 1..5 onto 0..1, gated on a level-3 skill", () => {
    const novelty = (originality: number, level = 3) =>
      aggregateProfile("p", "P", judgment([{ level, originality }]), NOW).novelty;
    expect([1, 2, 3, 4, 5].map((value) => novelty(value))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(novelty(5, 2)).toBe(0);
  });
});

describe("upstream pull-request bonus", () => {
  it("is zero without PRs and capped at MAX_UPSTREAM_BONUS", () => {
    expect(upstreamBonus(0)).toBe(0);
    expect(upstreamBonus(-3)).toBe(0);
    expect(upstreamBonus(2)).toBeCloseTo(0.2, 6);
    expect(upstreamBonus(500)).toBe(MAX_UPSTREAM_BONUS);
  });

  it("lifts a repo-evidenced skill by at most the cap and never above 5", () => {
    const input = judgment([{ level: 3 }]);
    const base = levelOf(aggregateProfile("p", "P", input, NOW)) ?? 0;
    const lifted = levelOf(
      aggregateProfile("p", "P", input, NOW, { signals: { mergedUpstreamPullRequests: 99 } }),
    );
    expect(lifted).toBeCloseTo(base + MAX_UPSTREAM_BONUS, 6);
    const top = aggregateProfile("p", "P", judgment([{ level: 5 }]), NOW, {
      signals: { mergedUpstreamPullRequests: 99 },
    });
    expect(levelOf(top)).toBe(5);
  });

  it("does not lift tutorial-level skills or CV-only claims", () => {
    const low = aggregateProfile("p", "P", judgment([{ level: 1 }]), NOW, {
      signals: { mergedUpstreamPullRequests: 99 },
    });
    expect(levelOf(low)).toBe(1);
    const cvOnly = aggregateProfile(
      "p",
      "P",
      {
        thoughts: "",
        summary: "s",
        repos: [],
        cv: { claims: [{ id: "figma", quote: "Figma", thought: "", level: 3 }] },
        flags: [],
      },
      NOW,
      { signals: { mergedUpstreamPullRequests: 99 } },
    );
    expect(levelOf(cvOnly)).toBe(3);
  });
});
