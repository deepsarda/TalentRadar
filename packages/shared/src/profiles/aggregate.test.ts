import { describe, expect, it } from "vitest";
import { PersonProfileSchema, ProfileSkillSchema } from "../schemas.js";
import { taxonomy } from "../taxonomy/taxonomy.js";
import {
  aggregateProfile,
  type ProfileJudgment,
  UNANALYSED_NOTE,
  withDetectedTools,
} from "./aggregate.js";

const domainIds = Object.keys(taxonomy.domains);

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

  it("includes all domains as explicit no-evidence scores when no repositories demonstrate them", () => {
    const profile = aggregateProfile("person", "Person", {
      thoughts: "",
      summary: "No repo evidence",
      repos: [],
      cv: { claims: [] },
      flags: [],
    });
    expect(profile.skills.map((skill) => skill.id).sort()).toEqual([...domainIds].sort());
    for (const domain of profile.skills) {
      expect(domain).toMatchObject({ level: 0, effective: 0, confidence: "low", evidence: [] });
      expect(domain.thought).toContain("No evidence");
    }
    expect(PersonProfileSchema.safeParse(profile).success).toBe(true);
    expect(ProfileSkillSchema.safeParse({ ...profile.skills[0], id: "react" }).success).toBe(false);
    expect(ProfileSkillSchema.safeParse({ ...profile.skills[0], id: "constructor" }).success).toBe(
      false,
    );
  });

  it("does not dilute a positive domain score or raise confidence with no-evidence repositories", () => {
    const base = {
      commitSha: "a123456",
      pushedAt: "2026-10-01T00:00:00Z",
      authorship: 1,
      originality: 4,
    };
    const noEvidence = { id: "backend", evidence: [], thought: "No backend evidence.", level: 0 };
    const profile = aggregateProfile("person", "Person", {
      thoughts: "",
      summary: "Backend work",
      cv: { claims: [] },
      flags: [],
      repos: [
        {
          ...base,
          repo: "person/api",
          skills: [
            {
              id: "backend",
              evidence: [{ path: "server.ts", note: "Service implementation" }],
              thought: "Strong service work.",
              level: 4,
            },
          ],
        },
        { ...base, repo: "person/art", skills: [noEvidence] },
        { ...base, repo: "person/docs", skills: [noEvidence] },
      ],
    });
    expect(profile.skills.find((skill) => skill.id === "backend")).toMatchObject({
      level: 4,
      confidence: "medium",
      effective: 3.4,
    });
  });
});

it("keeps combined domain explanations within the participant profile contract", () => {
  const profile = aggregateProfile("person", "Person", {
    thoughts: "",
    summary: "Backend work",
    cv: { claims: [] },
    flags: [],
    repos: ["api", "service"].map((name) => ({
      repo: `person/${name}`,
      commitSha: "a123456",
      pushedAt: "2026-10-01T00:00:00Z",
      authorship: 1,
      originality: 4,
      skills: [
        {
          id: "backend",
          evidence: [{ path: "server.ts", note: "Service implementation" }],
          thought: "Architecture and tested error handling. ".repeat(12),
          level: 4,
        },
      ],
    })),
  });
  expect(
    profile.skills.find((skill) => skill.id === "backend")?.thought.length,
  ).toBeLessThanOrEqual(600);
  expect(PersonProfileSchema.safeParse(profile).success).toBe(true);
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
