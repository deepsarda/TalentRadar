import { describe, expect, it } from "vitest";
import type { PersonProfile } from "../schemas.js";
import {
  pseudonymizePersonName,
  pseudonymizeTeamName,
  redactProfileForBlindReview,
  redactSnapshotPersonForBlindReview,
  redactTeamForBlindReview,
} from "./blind.js";
import type { DecidedTeam } from "./select.js";

describe("blind evaluation mode", () => {
  it("generates deterministic pseudonyms for teams and individuals", () => {
    const team1 = pseudonymizeTeamName("team-123", "event-salt");
    const team1Repeat = pseudonymizeTeamName("team-123", "event-salt");
    const team2 = pseudonymizeTeamName("team-456", "event-salt");

    expect(team1).toBe(team1Repeat);
    expect(team1).toMatch(/^Team [A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(team2).toMatch(/^Team [A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(team1).not.toBe(team2);

    const person1 = pseudonymizePersonName("person-abc", "event-salt");
    const person1Repeat = pseudonymizePersonName("person-abc", "event-salt");
    const person2 = pseudonymizePersonName("person-def", "event-salt");

    expect(person1).toBe(person1Repeat);
    // Now 8 hex chars (was 4)
    expect(person1).toMatch(/^Candidate #[0-9A-F]{8,16}$/);
    expect(person1).not.toBe(person2);
  });

  it("person pseudonyms have 5000-ID collision resistance", () => {
    const salt = "test-event-2026";
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(pseudonymizePersonName(`person-${i}`, salt));
    }
    // All 5000 pseudonyms must be unique
    expect(ids.size).toBe(5000);
  });

  it("redacts identifiable attributes from person profile", () => {
    const profile: PersonProfile = {
      personId: "p-1",
      displayName: "Deep Sarda",
      skills: [
        {
          id: "frontend",
          level: 4,
          confidence: "high",
          effective: 4,
          evidence: [],
          thought: "Good code",
        },
      ],
      novelty: 0.5,
      flags: [],
      summary:
        "Full-stack engineer at SVNIT Surat with 5 years experience. See github.com/deepsarda for projects.",
    };

    const redacted = redactProfileForBlindReview(profile, "salt");
    expect(redacted.displayName).toMatch(/^Candidate #[0-9A-F]{8,16}$/);
    expect(redacted.displayName).not.toContain("Deep");
    // Summary is replaced wholesale — no GitHub link or college leaks
    expect(redacted.summary).toContain("Blind Evaluation");
    expect(redacted.summary).not.toContain("github.com");
    expect(redacted.summary).not.toContain("SVNIT");
    expect(redacted.skills).toEqual(profile.skills);
    expect(redacted.novelty).toBe(0.5);
  });

  it("redacts team demographic and identity fields", () => {
    const team: DecidedTeam = {
      teamId: "t-1",
      name: "SuperCoders SVNIT",
      memberIds: ["p-1", "p-2"],
      submittedAt: "2026-10-10T10:00:00.000Z",
      fit: 0.9,
      depth: 4.0,
      novelty: 0.25,
      score: 85,
      rank: 1,
      eligible: true,
      ineligibleReasons: [],
      breakdown: [],
      status: "selected",
      waitlistPosition: null,
      borderline: false,
    };

    const redacted = redactTeamForBlindReview(team, "salt");
    expect(redacted.name).toMatch(/^Team [A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(redacted.name).not.toContain("SVNIT");
    expect(redacted.score).toBe(85);
    expect(redacted.memberIds).toEqual(team.memberIds);
  });

  it("redacts snapshot person fields (github, email, college)", () => {
    const snapshotPerson = {
      personId: "p-42",
      name: "Alice Liddell",
      email: "alice@example.com",
      github: "alicegithub",
      college: "Wonderland University",
      collegeNormalized: "wonderland university",
      year: "3rd",
      profileStatus: "ready" as const,
      profile: null,
    };

    const redacted = redactSnapshotPersonForBlindReview(snapshotPerson, "event-salt", "p-42");
    expect(redacted).not.toHaveProperty("email");
    expect(redacted).not.toHaveProperty("github");
    expect(redacted).not.toHaveProperty("college");
    expect(redacted).not.toHaveProperty("collegeNormalized");
    expect(redacted.displayName).toMatch(/^Candidate #[0-9A-F]{8,16}$/);
    // Non-identifying fields are preserved
    expect((redacted as Record<string, unknown>)["year"]).toBe("3rd");
  });
});
