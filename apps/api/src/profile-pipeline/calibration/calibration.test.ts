import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type CalibrationEntry,
  CalibrationEntrySchema,
  CalibrationSetSchema,
  compositionWarnings,
  scoreEntry,
  summarize,
} from "./calibration.js";

/** Test-only example; not a real repo and never part of calibration-set.json. */
const example: CalibrationEntry = {
  repository: "test-only/example",
  commitSha: "a".repeat(40),
  kind: "ordinary",
  originality: { scorerA: 4, scorerB: 3 },
  skills: { react: { scorerA: 2, scorerB: 3 }, express: { scorerA: 3, scorerB: 3 } },
};

describe("calibration scoring", () => {
  it("counts a repo as within when every dimension is within one level of the human mean", () => {
    // Means: originality 3.5, react 2.5, express 3. Model: 4.5 -> |1.0|, 1.5 -> |1.0|, 2 -> |1|.
    const score = scoreEntry(example, {
      originality: 4.5,
      skills: [
        { id: "react", level: 1.5 },
        { id: "express", level: 2 },
        { id: "docker", level: 5 },
      ],
    });
    expect(score.within).toBe(true);
    expect(score.dimensions.map((item) => item.humanMean)).toEqual([3.5, 2.5, 3]);
  });

  it("fails a repo on one dimension off by more than one, or a skill the model missed", () => {
    expect(
      scoreEntry(example, {
        originality: 5,
        skills: [
          { id: "react", level: 3 },
          { id: "express", level: 3 },
        ],
      }).within,
    ).toBe(false);
    const missing = scoreEntry(example, { originality: 4, skills: [{ id: "react", level: 3 }] });
    expect(missing.within).toBe(false);
    expect(missing.dimensions.find((item) => item.dimension === "express")?.model).toBeNull();
    expect(scoreEntry(example, null).within).toBe(false);
  });

  it("flags human disagreement of more than one level", () => {
    const split = { ...example, originality: { scorerA: 2, scorerB: 5 } };
    expect(scoreEntry(split, null).dimensions[0]?.humansDisagree).toBe(true);
  });

  it("reports N of 10 and passes only at 8 or more of a full set", () => {
    const within = scoreEntry(example, {
      originality: 3,
      skills: [
        { id: "react", level: 3 },
        { id: "express", level: 3 },
      ],
    });
    const off = scoreEntry(example, null);
    const eight = summarize([...Array(8).fill(within), ...Array(2).fill(off)]);
    expect(eight.line).toContain("on 8 of 10");
    expect(eight.passed).toBe(true);
    expect(summarize([...Array(7).fill(within), ...Array(3).fill(off)]).passed).toBe(false);
    expect(summarize(Array(8).fill(within)).passed).toBe(false);
  });
});

describe("calibration set format", () => {
  it("ships a valid set: nothing fabricated, and still valid once people fill it in", async () => {
    const file = await readFile(new URL("./calibration-set.json", import.meta.url), "utf8");
    const set = CalibrationSetSchema.parse(JSON.parse(file));
    // Labels must come from people reading code. This used to assert the set was empty, which
    // would fail the build the day the first real entry was added. Validity is the invariant now;
    // the CI gate (calibration-gate.ts) enforces completeness and accuracy once there are 10.
    expect(set.entries.length).toBeLessThanOrEqual(10);
    expect(set.entries.every((entry) => !entry.repository.startsWith("test-only/"))).toBe(true);
    expect(compositionWarnings(set).length).toBeLessThanOrEqual(3);
  });

  it("rejects unknown skill ids, out-of-range scores and few-shot repos", () => {
    expect(CalibrationEntrySchema.safeParse(example).success).toBe(true);
    const bad = (patch: Partial<CalibrationEntry>) =>
      CalibrationEntrySchema.safeParse({ ...example, ...patch }).success;
    expect(bad({ skills: { reactjs: { scorerA: 3, scorerB: 3 } } })).toBe(false);
    expect(bad({ originality: { scorerA: 6, scorerB: 3 } })).toBe(false);
    expect(bad({ repository: "example-user-3/raga-automaton" })).toBe(false);
  });
});
