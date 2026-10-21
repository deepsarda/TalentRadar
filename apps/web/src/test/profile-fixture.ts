import type { OrganizerParticipantProfile } from "../lib/api";

export const profileFixture = {
  person: {
    personId: "riya",
    name: "Riya Patel",
    github: "riya",
    college: "SVNIT",
    year: "3",
    branch: "CS",
  },
  profile: {
    id: "profile-riya",
    version: 2,
    status: "ready",
    displayName: "Riya Patel",
    novelty: 0.25,
    flags: ["readme_overclaims" as const],
    taxonomyVersion: "v3",
    summary: "Builds original APIs.",
    repos: [{ fullName: "riya/app", sha: "abc1234", included: true }],
    assessment: {
      thoughts: "An original API using established patterns.",
      repositories: [
        {
          repository: "riya/app",
          commitSha: "abc1234",
          originality: 4,
          authorship: 0.75,
          qualifiesForNovelty: true,
        },
      ],
    },
    skills: [
      {
        id: "backend",
        level: 3,
        effective: 2.55,
        confidence: "medium",
        thought: "Routes and error handling.",
        evidence: [
          { repository: "riya/app", commitSha: "abc1234", path: "server.ts", note: "API routes" },
        ],
      },
      {
        id: "ai_ml",
        level: 0,
        effective: 0,
        confidence: "low",
        thought: "No evidence in the reviewed inputs.",
        evidence: [],
      },
    ],
  },
} satisfies OrganizerParticipantProfile;
