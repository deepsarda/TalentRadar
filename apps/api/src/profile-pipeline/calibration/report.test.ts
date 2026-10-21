import { describe, expect, it } from "vitest";
import { CALIBRATION_SIZE, type CalibrationEntry, CalibrationSetSchema } from "./calibration.js";
import {
  buildResults,
  type CalibrationVersions,
  checkResults,
  evaluateGate,
  scorerAgreement,
  setDigest,
  validateSet,
} from "./report.js";

/*
 * Every entry here is synthetic and test-only. None of it touches calibration-set.json: the real
 * labels must come from people reading code.
 */

const versions: CalibrationVersions = {
  model: "test-model",
  prompt: "p1",
  taxonomy: "t1",
  rubric: "r1",
  sampler: "s1",
};
const { model: _model, ...codeVersions } = versions;

function entry(index: number, patch: Partial<CalibrationEntry> = {}): CalibrationEntry {
  return {
    repository: `test-only/repo-${index}`,
    commitSha: index.toString(16).padStart(40, "a"),
    kind: index < 2 ? "genuine_novel" : index < 4 ? "looks_novel_but_not" : "ordinary",
    originality: { scorerA: 3, scorerB: 3 },
    skills: { react: { scorerA: 3, scorerB: 3 }, express: { scorerA: 2, scorerB: 3 } },
    ...patch,
  };
}

const fullEntries = () => Array.from({ length: CALIBRATION_SIZE }, (_, index) => entry(index));
const setOf = (entries: CalibrationEntry[]) => CalibrationSetSchema.parse({ entries });

/** What the judge "said": agrees with the humans (means 3, 3 and 2.5) exactly. */
const agreeing = {
  originality: 3,
  skills: [
    { id: "react", level: 3 },
    { id: "express", level: 2.5 },
  ],
};
/** Off by 2 on originality: a miss. */
const missing = { ...agreeing, originality: 5 };

function results(set: ReturnType<typeof setOf>, misses: number, overrides: object = {}) {
  return {
    ...buildResults({
      set,
      versions,
      now: new Date("2026-10-21T00:00:00Z"),
      scored: set.entries.map((item, index) => ({
        repository: item.repository,
        judgedCommitSha: item.commitSha,
        model: index < misses ? missing : agreeing,
      })),
    }),
    ...overrides,
  };
}

describe("validateSet", () => {
  it("accepts a well-formed set and reports no errors", () => {
    const report = validateSet({ entries: fullEntries() });
    expect(report.errors).toEqual([]);
    expect(report.set?.entries).toHaveLength(10);
  });

  it("accepts an empty set with a warning about its size", () => {
    const report = validateSet({ entries: [] });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toContain("0 of 10");
  });

  it("rejects a commit SHA that is not 40 hex characters, naming the repo", () => {
    const report = validateSet({
      entries: [entry(0, { commitSha: "abc123" }), entry(1, { commitSha: `${"z".repeat(40)}` })],
    });
    expect(report.set).toBeNull();
    expect(
      report.errors.some((e) => e.includes("test-only/repo-0") && e.includes("commitSha")),
    ).toBe(true);
    expect(report.errors.some((e) => e.includes("test-only/repo-1"))).toBe(true);
  });

  it("requires two scorers on originality and every skill", () => {
    const noB = { ...entry(0), originality: { scorerA: 3 } };
    const onlyOneSkillScorer = { ...entry(1), skills: { react: { scorerA: 3 } } };
    const report = validateSet({ entries: [noB, onlyOneSkillScorer] });
    expect(report.errors.join("\n")).toContain("originality.scorerB");
    expect(report.errors.join("\n")).toContain("skills.react.scorerB");
  });

  it("rejects out-of-range and non-integer scores and a third scorer", () => {
    for (const originality of [
      { scorerA: 0, scorerB: 3 },
      { scorerA: 6, scorerB: 3 },
      { scorerA: 2.5, scorerB: 3 },
      { scorerA: 3, scorerB: 3, scorerC: 3 },
    ]) {
      expect(validateSet({ entries: [entry(0, { originality })] }).errors.length).toBeGreaterThan(
        0,
      );
    }
  });

  it("rejects ids that are not in the taxonomy", () => {
    const report = validateSet({
      entries: [entry(0, { skills: { reactjs: { scorerA: 3, scorerB: 3 } } })],
    });
    expect(report.errors.join("\n")).toContain("taxonomy ids");
  });

  it("rejects duplicate repos (case-insensitive) and more than ten entries", () => {
    const dup = validateSet({
      entries: [entry(0), entry(1, { repository: "TEST-ONLY/REPO-0" })],
    });
    expect(dup.errors.join("\n")).toContain("once");
    const many = validateSet({
      entries: [...fullEntries(), entry(11)],
    });
    expect(many.set).toBeNull();
    expect(many.errors.length).toBeGreaterThan(0);
  });

  it("rejects a file that is not an object with an entries array", () => {
    expect(validateSet(null).errors).toHaveLength(1);
    expect(validateSet([]).errors).toHaveLength(1);
    expect(validateSet({ entries: "nope" }).errors).toHaveLength(1);
  });

  it("warns, not errors, when two scorers differ by more than one level", () => {
    const report = validateSet({
      entries: [entry(0, { originality: { scorerA: 1, scorerB: 4 } })],
    });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toContain("differ by more than one level on originality");
  });
});

describe("scorerAgreement", () => {
  it("counts exact, within one and the mean difference across all dimensions", () => {
    // Per entry: originality 0, react 0, express 1 -> two exact, one within-one.
    const agreement = scorerAgreement(setOf([entry(0), entry(1)]));
    expect(agreement).toMatchObject({ repositories: 2, dimensions: 6, exact: 4, withinOne: 6 });
    expect(agreement.meanAbsoluteDifference).toBeCloseTo(2 / 6);
    expect(agreement.disagreements).toEqual([]);
  });

  it("lists dimensions the scorers split by more than one level", () => {
    const agreement = scorerAgreement(
      setOf([entry(0, { skills: { react: { scorerA: 1, scorerB: 4 } } })]),
    );
    expect(agreement.disagreements).toEqual([
      { repository: "test-only/repo-0", dimension: "react", scorerA: 1, scorerB: 4, difference: 3 },
    ]);
  });

  it("handles an empty set", () => {
    expect(scorerAgreement(setOf([]))).toMatchObject({
      dimensions: 0,
      meanAbsoluteDifference: null,
    });
  });
});

describe("setDigest", () => {
  it("ignores entry order, key order and notes, but changes with any score or commit", () => {
    const entries = fullEntries();
    const base = setDigest(setOf(entries));
    expect(setDigest(setOf([...entries].reverse()))).toBe(base);
    expect(setDigest(setOf(entries.map((item) => ({ ...item, notes: "edited" }))))).toBe(base);
    const bumped = entries.map((item, index) =>
      index === 4 ? { ...item, originality: { scorerA: 3, scorerB: 4 } } : item,
    );
    expect(setDigest(setOf(bumped))).not.toBe(base);
    const moved = entries.map((item, index) =>
      index === 4 ? { ...item, commitSha: "b".repeat(40) } : item,
    );
    expect(setDigest(setOf(moved))).not.toBe(base);
  });
});

describe("checkResults", () => {
  const set = setOf(fullEntries());

  it("scores fresh results against the human mean", () => {
    const check = checkResults(set, results(set, 2), codeVersions);
    expect(check.errors).toEqual([]);
    expect(check.scores?.filter((score) => score.within)).toHaveLength(8);
  });

  it("refuses results made against different labels", () => {
    const edited = setOf(
      fullEntries().map((item, index) =>
        index === 0 ? { ...item, originality: { scorerA: 2, scorerB: 2 } } : item,
      ),
    );
    const check = checkResults(edited, results(set, 0), codeVersions);
    expect(check.scores).toBeNull();
    expect(check.errors.join("\n")).toContain("labels changed");
  });

  it("refuses results made under a different prompt, taxonomy, rubric or sampler version", () => {
    for (const key of ["prompt", "taxonomy", "rubric", "sampler"] as const) {
      const check = checkResults(set, results(set, 0), { ...codeVersions, [key]: "newer" });
      expect(check.scores).toBeNull();
      expect(check.errors.join("\n")).toContain(`${key} "`);
    }
  });

  it("treats the model as informational unless the caller pins it", () => {
    expect(checkResults(set, results(set, 0), codeVersions).errors).toEqual([]);
    expect(
      checkResults(set, results(set, 0), { ...codeVersions, model: "other-model" }).errors,
    ).toHaveLength(1);
  });

  it("refuses a missing, extra or duplicated repo and a judged commit that differs", () => {
    const full = results(set, 0);
    const dropped = { ...full, entries: full.entries.slice(1) };
    expect(checkResults(set, dropped, codeVersions).errors.join("\n")).toContain(
      "no judge result for test-only/repo-0",
    );
    const extra = {
      ...full,
      entries: [
        ...full.entries,
        { repository: "test-only/other", judgedCommitSha: null, model: null },
      ],
    };
    expect(checkResults(set, extra, codeVersions).errors.join("\n")).toContain(
      "not in the calibration set",
    );
    const duplicated = { ...full, entries: [...full.entries, full.entries[0]] };
    expect(checkResults(set, duplicated, codeVersions).errors.join("\n")).toContain(
      "more than once",
    );
    const moved = {
      ...full,
      entries: full.entries.map((item, index) =>
        index === 0 ? { ...item, judgedCommitSha: "c".repeat(40) } : item,
      ),
    };
    expect(checkResults(set, moved, codeVersions).errors.join("\n")).toContain(
      "comparison is meaningless",
    );
  });

  it("counts a repo the judge could not read as a miss, not an error", () => {
    const full = results(set, 0);
    const unread = {
      ...full,
      entries: full.entries.map((item, index) =>
        index === 0 ? { ...item, judgedCommitSha: null, model: null } : item,
      ),
    };
    const check = checkResults(set, unread, codeVersions);
    expect(check.errors).toEqual([]);
    expect(check.scores?.filter((score) => score.within)).toHaveLength(9);
  });

  it("rejects malformed results", () => {
    expect(checkResults(set, { entries: [] }, codeVersions).scores).toBeNull();
    expect(checkResults(set, "nope", codeVersions).errors.length).toBeGreaterThan(0);
  });
});

describe("evaluateGate", () => {
  const raw = { entries: fullEntries() };
  const set = setOf(fullEntries());

  it("is pending, with a loud message and exit 0, while the set has fewer than 10 entries", () => {
    for (const count of [0, 1, 9]) {
      const decision = evaluateGate(
        { entries: fullEntries().slice(0, count) },
        undefined,
        codeVersions,
      );
      expect(decision).toMatchObject({ status: "pending", exitCode: 0 });
      expect(decision.lines[0]).toContain(`${count} of 10`);
      expect(decision.lines[0]).toContain("NOT being measured");
    }
  });

  it("fails when the set is invalid, even when it is short", () => {
    const decision = evaluateGate(
      { entries: [entry(0, { commitSha: "short" })] },
      undefined,
      codeVersions,
    );
    expect(decision).toMatchObject({ status: "fail", exitCode: 1 });
  });

  it("fails a full set that has no judge results", () => {
    const decision = evaluateGate(raw, undefined, codeVersions);
    expect(decision).toMatchObject({ status: "fail", exitCode: 1 });
    expect(decision.lines[0]).toContain("no judge results");
  });

  it("passes at 8 of 10 and above, and fails at 7", () => {
    expect(evaluateGate(raw, results(set, 0), codeVersions)).toMatchObject({
      status: "pass",
      exitCode: 0,
    });
    expect(evaluateGate(raw, results(set, 2), codeVersions)).toMatchObject({
      status: "pass",
      exitCode: 0,
    });
    const seven = evaluateGate(raw, results(set, 3), codeVersions);
    expect(seven).toMatchObject({ status: "fail", exitCode: 1 });
    expect(seven.lines[0]).toContain("7 of 10");
    expect(seven.lines.filter((line) => line.includes("miss:"))).toHaveLength(3);
  });

  it("fails on stale results even if they would have passed", () => {
    const decision = evaluateGate(raw, results(set, 0), { ...codeVersions, prompt: "newer" });
    expect(decision).toMatchObject({ status: "fail", exitCode: 1 });
    expect(decision.lines.join("\n")).toContain("cannot be trusted");
  });

  it("is not satisfied by hand-editing the labels after the judge ran", () => {
    const fixed = {
      entries: fullEntries().map((item) => ({ ...item, originality: { scorerA: 5, scorerB: 5 } })),
    };
    expect(evaluateGate(fixed, results(set, 0), codeVersions).status).toBe("fail");
  });
});
