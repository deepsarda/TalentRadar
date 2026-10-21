import { describe, expect, it } from "vitest";
import { type ProfileJudgment, ProfileJudgmentSchema } from "./aggregate.js";
import { judgmentDisagreement, lowerMedian, mergeJudgments } from "./merge.js";

function skill(id: string, level: number, note = `evidence for ${id}@${level}`) {
  return { id, level, evidence: [{ path: "src/a.ts", note }], thought: `thought ${id}@${level}` };
}

function judgment(overrides: Partial<ProfileJudgment> = {}): ProfileJudgment {
  return {
    thoughts: "primary thoughts",
    summary: "primary summary",
    repos: [
      {
        repo: "alice/app",
        commitSha: "a".repeat(40),
        pushedAt: "2026-09-01T00:00:00Z",
        authorship: 0.9,
        originality: 4,
        skills: [skill("backend", 4), skill("frontend", 3)],
      },
    ],
    cv: { claims: [{ id: "ai_ml", quote: "built models", thought: "t", level: 3 }] },
    flags: [],
    ...overrides,
  };
}

function withSkills(levels: Record<string, number>, extra: Partial<ProfileJudgment> = {}) {
  const base = judgment(extra);
  const repo = base.repos[0] as ProfileJudgment["repos"][number];
  return {
    ...base,
    repos: [{ ...repo, skills: Object.entries(levels).map(([id, level]) => skill(id, level)) }],
  };
}

function levelOf(merged: ProfileJudgment, id: string) {
  return merged.repos[0]?.skills.find((candidate) => candidate.id === id)?.level;
}

describe("lowerMedian", () => {
  it("takes the middle value, and the lower middle for an even count", () => {
    expect(lowerMedian([3])).toBe(3);
    expect(lowerMedian([5, 2])).toBe(2);
    expect(lowerMedian([1, 5, 3])).toBe(3);
    expect(lowerMedian([4, 1, 5, 2])).toBe(2);
  });

  it("rejects an empty list", () => {
    expect(() => lowerMedian([])).toThrow();
  });
});

describe("mergeJudgments", () => {
  it("returns a single judgment unchanged and rejects none", () => {
    const only = judgment();
    expect(mergeJudgments([only])).toBe(only);
    expect(() => mergeJudgments([])).toThrow();
  });

  it("is the identity when two judges agree completely", () => {
    const merged = mergeJudgments([judgment(), judgment()]);
    expect(merged).toEqual(judgment());
  });

  it("credits the lower level when two judges disagree", () => {
    const merged = mergeJudgments([
      withSkills({ backend: 5, frontend: 3 }),
      withSkills({ backend: 3, frontend: 4 }),
    ]);
    expect(levelOf(merged, "backend")).toBe(3);
    expect(levelOf(merged, "frontend")).toBe(3);
  });

  it("is order-independent for levels (the stricter judge wins either way)", () => {
    const a = withSkills({ backend: 5 });
    const b = withSkills({ backend: 2 });
    expect(levelOf(mergeJudgments([a, b]), "backend")).toBe(2);
    expect(levelOf(mergeJudgments([b, a]), "backend")).toBe(2);
  });

  it("uses the true median with three judges", () => {
    const merged = mergeJudgments([
      withSkills({ backend: 5 }),
      withSkills({ backend: 2 }),
      withSkills({ backend: 4 }),
    ]);
    expect(levelOf(merged, "backend")).toBe(4);
  });

  it("drops a skill only one of two judges found, but keeps one 2 of 3 found", () => {
    const two = mergeJudgments([withSkills({ backend: 4, devops: 3 }), withSkills({ backend: 4 })]);
    expect(two.repos[0]?.skills.map((s) => s.id)).toEqual(["backend"]);
    const three = mergeJudgments([
      withSkills({ backend: 4, devops: 3 }),
      withSkills({ backend: 4, devops: 2 }),
      withSkills({ backend: 4 }),
    ]);
    expect(levelOf(three, "devops")).toBe(2);
  });

  it("carries evidence and reasoning from a judge at the merged level", () => {
    const merged = mergeJudgments([withSkills({ backend: 5 }), withSkills({ backend: 3 })]);
    const merged0 = merged.repos[0]?.skills[0];
    expect(merged0?.thought).toBe("thought backend@3");
    expect(merged0?.evidence[0]?.note).toBe("evidence for backend@3");
  });

  it("takes median originality and authorship per repository", () => {
    const a = judgment();
    const b = judgment({
      repos: [
        { ...(a.repos[0] as ProfileJudgment["repos"][number]), originality: 2, authorship: 0.5 },
      ],
    });
    const repo = mergeJudgments([a, b]).repos[0];
    expect(repo?.originality).toBe(2);
    expect(repo?.authorship).toBe(0.5);
  });

  it("drops a repository only one judge returned", () => {
    const a = judgment();
    const extra = {
      ...(a.repos[0] as ProfileJudgment["repos"][number]),
      repo: "alice/other",
    };
    const merged = mergeJudgments([{ ...a, repos: [...a.repos, extra] }, a]);
    expect(merged.repos.map((repo) => repo.repo)).toEqual(["alice/app"]);
  });

  it("merges CV claims by the same rules", () => {
    const merged = mergeJudgments([
      judgment({ cv: { claims: [{ id: "ai_ml", quote: "q", thought: "t", level: 5 }] } }),
      judgment({ cv: { claims: [{ id: "ai_ml", quote: "q", thought: "t", level: 2 }] } }),
    ]);
    expect(merged.cv.claims[0]?.level).toBe(2);
    const unmatched = mergeJudgments([
      judgment({ cv: { claims: [{ id: "ai_ml", quote: "q", thought: "t", level: 5 }] } }),
      judgment({ cv: { claims: [] } }),
    ]);
    expect(unmatched.cv.claims).toEqual([]);
  });

  it("keeps prompt-injection if either judge raised it, other flags only if both did", () => {
    const merged = mergeJudgments([
      judgment({ flags: ["possible_prompt_injection", "readme_overclaims"] }),
      judgment({ flags: ["mostly_boilerplate"] }),
    ]);
    expect(merged.flags).toEqual(["possible_prompt_injection"]);
    const both = mergeJudgments([
      judgment({ flags: ["readme_overclaims"] }),
      judgment({ flags: ["readme_overclaims"] }),
    ]);
    expect(both.flags).toEqual(["readme_overclaims"]);
  });

  it("keeps the primary judgment's thoughts and summary", () => {
    const merged = mergeJudgments([
      judgment(),
      judgment({ thoughts: "second thoughts", summary: "second summary" }),
    ]);
    expect(merged.thoughts).toBe("primary thoughts");
    expect(merged.summary).toBe("primary summary");
  });

  it("never mutates its inputs and always satisfies the schema", () => {
    const a = withSkills({ backend: 5, frontend: 1 }, { flags: ["readme_overclaims"] });
    const b = withSkills({ backend: 2, frontend: 4 });
    const before = JSON.stringify([a, b]);
    const merged = mergeJudgments([a, b]);
    expect(JSON.stringify([a, b])).toBe(before);
    expect(() => ProfileJudgmentSchema.parse(merged)).not.toThrow();
  });

  it("never rates any skill above the most generous judge or below the strictest", () => {
    for (const levels of [
      [1, 5],
      [3, 3],
      [5, 4, 1],
      [2, 2, 5, 5],
    ]) {
      const merged = mergeJudgments(levels.map((level) => withSkills({ backend: level })));
      const level = levelOf(merged, "backend") as number;
      expect(level).toBeGreaterThanOrEqual(Math.min(...levels));
      expect(level).toBeLessThanOrEqual(Math.max(...levels));
    }
  });
});

describe("judgmentDisagreement", () => {
  it("reports zero when the judges agree", () => {
    expect(judgmentDisagreement([judgment(), judgment()])).toEqual({
      comparedSkills: 3,
      meanLevelGap: 0,
      maxLevelGap: 0,
      skillsInOnlySome: 0,
      flagsDiffer: false,
    });
  });

  it("measures gaps, one-sided skills and differing flags", () => {
    const result = judgmentDisagreement([
      withSkills({ backend: 5, frontend: 3, devops: 2 }, { flags: ["readme_overclaims"] }),
      withSkills({ backend: 3, frontend: 3 }),
    ]);
    // compared: backend (gap 2), frontend (gap 0), cv ai_ml (gap 0); devops only in one judge
    expect(result.comparedSkills).toBe(3);
    expect(result.meanLevelGap).toBeCloseTo(2 / 3, 10);
    expect(result.maxLevelGap).toBe(2);
    expect(result.skillsInOnlySome).toBe(1);
    expect(result.flagsDiffer).toBe(true);
  });
});
