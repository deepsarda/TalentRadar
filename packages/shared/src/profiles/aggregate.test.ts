import { describe, expect, it } from "vitest";
import { aggregateProfile, type ProfileJudgment } from "./aggregate.js";

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
