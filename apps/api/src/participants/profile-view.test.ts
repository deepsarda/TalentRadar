import type { ProfileJudgment } from "@talentradar/shared";
import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import { createOrganizerEventsApi } from "../events/organizer-events.js";
import { createParticipantApi } from "./participant-api.js";

const userId = new ObjectId();
const personId = new ObjectId();
const eventId = new ObjectId();
const profileId = new ObjectId();
const assessmentId = new ObjectId();
const sha = "a".repeat(40);
const judgment: ProfileJudgment = {
  thoughts: "An original API using established patterns.",
  summary: "Backend developer",
  repos: [
    {
      repo: "riya/app",
      commitSha: sha,
      pushedAt: "2026-10-01T00:00:00Z",
      authorship: 0.75,
      originality: 4,
      skills: [
        {
          id: "backend",
          level: 3,
          thought: "API implementation",
          evidence: [{ path: "server.ts", note: "API routes" }],
        },
      ],
    },
  ],
  cv: { claims: [{ id: "backend", level: 2, quote: "Private CV quote", thought: "CV claim" }] },
  flags: [],
};

function setup(
  options: {
    signedIn?: boolean;
    owner?: boolean;
    registered?: boolean;
    result?: unknown;
    noProfile?: boolean;
  } = {},
) {
  const profile = {
    _id: profileId,
    personId,
    assessmentId,
    status: "ready",
    version: 2,
    displayName: "Riya",
    repos: [{ fullName: "riya/app", included: true, sha }],
    skills: [],
    novelty: 0.25,
    flags: [],
    taxonomyVersion: "v3",
  };
  const rows: Record<string, Array<Record<string, unknown>>> = {
    users: [{ _id: userId, login: "riya" }],
    people: [{ _id: personId, userId, name: "Riya", github: "riya", college: "SVNIT" }],
    hackathons: [
      { _id: eventId, organizerIds: options.owner === false ? [new ObjectId()] : [userId] },
    ],
    registrations: options.registered === false ? [] : [{ hackathonId: eventId, personId }],
    profiles: options.noProfile ? [] : [{ ...profile, version: 1 }, profile],
    assessments: [
      {
        _id: assessmentId,
        result: Object.hasOwn(options, "result") ? options.result : judgment,
        facts: "private facts",
        cvLinks: ["https://private.example"],
      },
    ],
  };
  const same = (left: unknown, right: unknown): boolean =>
    left instanceof ObjectId ? left.equals(right as ObjectId) : left === right;
  const reads = vi.fn();
  const collection = (name: string) => {
    const matching = (filter: Record<string, unknown>) =>
      (rows[name] ?? []).filter((row) =>
        Object.entries(filter).every(([key, value]) =>
          Array.isArray(row[key])
            ? row[key].some((entry: unknown) => same(entry, value))
            : same(row[key], value),
        ),
      );
    return {
      findOne: async (filter: Record<string, unknown>) => {
        reads(name, filter);
        return matching(filter)[0] ?? null;
      },
      find: (filter: Record<string, unknown>) => {
        reads(name, filter);
        const items = matching(filter).sort(
          (left, right) => Number(right["version"] ?? 0) - Number(left["version"] ?? 0),
        );
        const cursor = {
          sort: () => cursor,
          limit: () => cursor,
          next: async () => items[0] ?? null,
          toArray: async () => items,
        };
        return cursor;
      },
    };
  };
  const authentication = {
    currentUser: async () => (options.signedIn === false ? null : { id: userId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  const db = { collection } as never;
  createOrganizerEventsApi(db, authentication).register(app);
  createParticipantApi(db, authentication, {
    SESSION_SECRET: "s".repeat(32),
  } as Environment).register(app);
  return { app, reads };
}

const organizerPath = `/api/organizer/events/${eventId}/participants/${personId}/profile`;

describe("profile viewing", () => {
  it("shows the latest saved originality assessment on both profile endpoints without exposing CV inputs", async () => {
    const { app } = setup();
    for (const path of [organizerPath, "/api/participant/profile"]) {
      const response = await request(app).get(path).expect(200);
      expect(response.body.profile.version).toBe(2);
      expect(response.body.profile.assessment).toEqual({
        thoughts: judgment.thoughts,
        repositories: [
          {
            repository: "riya/app",
            commitSha: sha,
            originality: 4,
            authorship: 0.75,
            qualifiesForNovelty: true,
          },
        ],
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /Private CV quote|private facts|private.example/,
      );
    }
  });

  it("does not qualify original work without level 3 code evidence", async () => {
    const { app } = setup({
      result: {
        ...judgment,
        repos: judgment.repos.map((repo) => ({
          ...repo,
          originality: 5,
          skills: repo.skills.map((skill) => ({ ...skill, level: 2 })),
        })),
      },
    });
    const response = await request(app).get(organizerPath).expect(200);
    expect(response.body.profile.assessment.repositories[0].qualifiesForNovelty).toBe(false);
  });

  it("keeps legacy profiles readable when their assessment is missing or invalid", async () => {
    for (const result of [undefined, { incomplete: true }]) {
      const { app } = setup({ result });
      const response = await request(app).get(organizerPath).expect(200);
      expect(response.body.profile.novelty).toBe(0.25);
      expect(response.body.profile).not.toHaveProperty("assessment");
    }
  });

  it("represents a registered person who has no profile yet", async () => {
    const { app } = setup({ noProfile: true });
    const response = await request(app).get(organizerPath).expect(200);
    expect(response.body.person.name).toBe("Riya");
    expect(response.body.profile).toBeNull();
  });

  it.each([
    { signedIn: false, status: 401 },
    { owner: false, status: 404 },
    { registered: false, status: 404 },
  ])("blocks access before reading a profile: %j", async ({ status, ...options }) => {
    const { app, reads } = setup(options);
    await request(app).get(organizerPath).expect(status);
    expect(reads.mock.calls.some(([name]) => name === "profiles" || name === "assessments")).toBe(
      false,
    );
  });

  it("does not let an organizer look up someone outside their event", async () => {
    const { app, reads } = setup();
    await request(app)
      .get(`/api/organizer/events/${eventId}/participants/${new ObjectId()}/profile`)
      .expect(404);
    expect(reads.mock.calls.some(([name]) => name === "profiles")).toBe(false);
  });
});
