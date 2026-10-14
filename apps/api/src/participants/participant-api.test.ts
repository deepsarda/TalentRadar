import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../auth/crypto.js";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import { assessmentCacheKey } from "../profile-pipeline/cache-key.js";
import { createParticipantApi } from "./participant-api.js";

const environment = {
  SESSION_SECRET: "s".repeat(32),
  GEMINI_MODEL: "gemini-test",
} as Environment;
const builtSha = "a".repeat(40);
const userId = new ObjectId();
const personId = new ObjectId();
const cvFileId = new ObjectId();
const assessmentId = new ObjectId();
const profileId = new ObjectId();

/** Records inserts; serves one person with a ready v1 profile built from riya/app @ builtSha. */
function setup(options: { headSha: string; cvHash: string }) {
  const inserted: { profiles: Array<{ version?: unknown }>; jobs: Array<{ type?: unknown }> } = {
    profiles: [],
    jobs: [],
  };
  const readyProfile = {
    _id: profileId,
    personId,
    displayName: "Riya",
    status: "ready",
    version: 1,
    assessmentId,
    repos: [{ fullName: "riya/app", sha: builtSha, included: true }],
  };
  const one: Record<string, unknown> = {
    users: {
      _id: userId,
      login: "riya",
      encryptedAccessToken: encryptSecret("tok", "s".repeat(32)),
    },
    people: { _id: personId, userId, name: "Riya", currentCvFileId: cvFileId },
    hackathons: { _id: new ObjectId(), slug: "hack", kind: "event" },
    assessments: {
      _id: assessmentId,
      cacheKey: assessmentCacheKey([{ repo: "riya/app", sha: builtSha }], "cv-1", environment),
    },
    "cv.files": { _id: cvFileId, metadata: { sha256: options.cvHash } },
    registrations: null,
  };
  const collection = (name: string) => ({
    findOne: async () => one[name] ?? null,
    find: () => {
      const items = name === "profiles" ? [readyProfile] : [];
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        next: async () => items[0] ?? null,
        toArray: async () => items,
      };
      return cursor;
    },
    updateOne: async () => ({ modifiedCount: 1 }),
    findOneAndUpdate: async () => ({ _id: new ObjectId(), status: "draft" }),
    insertOne: async (doc: { type?: unknown }) => {
      if (name === "profiles" || name === "jobs") inserted[name].push(doc);
      return { insertedId: new ObjectId() };
    },
  });
  const fakeFetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/user/repos")) {
      return Response.json([
        {
          full_name: "riya/app",
          name: "app",
          description: null,
          html_url: "https://github.com/riya/app",
          default_branch: "main",
          fork: false,
          archived: false,
          size: 10,
          pushed_at: "2026-10-01T00:00:00Z",
          language: "TypeScript",
        },
      ]);
    }
    if (href === "https://api.github.com/repos/riya/app/commits/main") {
      return new Response(options.headSha);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const authentication = {
    currentUser: async () => ({ id: userId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  app.use(express.json());
  createParticipantApi({ collection } as never, authentication, environment, fakeFetch).register(
    app,
  );
  return { app, inserted };
}

const application = {
  details: { name: "Riya", college: "SVNIT", year: "3", branch: "Computer Science" },
  repositories: ["riya/app"],
  consent: true,
};

describe("returning-profile reuse", () => {
  it("reuses the ready profile when repos, commits and CV are unchanged", async () => {
    const { app, inserted } = setup({ headSha: builtSha, cvHash: "cv-1" });
    const response = await request(app)
      .post("/api/participant/events/hack/applications")
      .send(application)
      .expect(201);
    expect(response.body.profile).toMatchObject({ id: profileId.toHexString(), reused: true });
    expect(inserted.profiles).toHaveLength(0);
    expect(inserted.jobs).toHaveLength(0);
  });

  it("builds a new version when a repo has new commits", async () => {
    const { app, inserted } = setup({ headSha: "b".repeat(40), cvHash: "cv-1" });
    const response = await request(app)
      .post("/api/participant/events/hack/applications")
      .send(application)
      .expect(201);
    expect(response.body.profile).toMatchObject({ version: 2, reused: false });
    expect(inserted.profiles).toHaveLength(1);
    expect(inserted.jobs.map((job) => job.type).sort()).toEqual(["fetch_repo", "render_cv"]);
  });

  it("rebuilds after Replace CV, because the CV hash changed", async () => {
    const { app, inserted } = setup({ headSha: builtSha, cvHash: "cv-2" });
    const response = await request(app).post("/api/participant/profile/rebuild").expect(201);
    expect(response.body.profile).toMatchObject({ version: 2, reused: false });
    expect(inserted.jobs).toHaveLength(2);
  });
});
