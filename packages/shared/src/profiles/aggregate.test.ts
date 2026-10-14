import { describe, expect, it } from "vitest";
import {
  aggregateProfile,
  type ProfileJudgment,
  UNANALYSED_NOTE,
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
      level: 3.18,
      confidence: "high",
      effective: 3.18,
    });
    expect(profile.novelty).toBe(0.25);
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
