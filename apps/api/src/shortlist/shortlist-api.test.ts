import express from "express";
import { MongoServerError, ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import { ensureIndexes } from "../database/mongo.js";
import { createShortlistApi, UNTEAMED_NOTE } from "./shortlist-api.js";

type Doc = Record<string, unknown>;
type Operators = { $in?: unknown[]; $ne?: unknown };
type Update = { $set?: Doc & { published?: boolean }; $unset?: Doc };

function read(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Doc | undefined)?.[key], doc);
}

function same(left: unknown, right: unknown): boolean {
  return left instanceof ObjectId || right instanceof ObjectId
    ? String(left) === String(right)
    : left === right;
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = read(doc, path);
    if (expected && typeof expected === "object" && !(expected instanceof ObjectId)) {
      const operators = expected as Operators;
      if (operators.$in) {
        return operators.$in.some((value) =>
          Array.isArray(actual) ? actual.some((item) => same(item, value)) : same(actual, value),
        );
      }
      if ("$ne" in operators) return !same(actual, operators.$ne);
      return true;
    }
    return Array.isArray(actual)
      ? actual.some((item) => same(item, expected))
      : same(actual, expected);
  });
}

/** An in-memory Db with just the operations the shortlist routes use. */
function fakeDb(
  data: Record<string, Doc[]>,
  hooks: { beforeUpdate?: (name: string, update: Update) => void } = {},
) {
  const collection = (name: string) => {
    data[name] ??= [];
    const docs = () => data[name] ?? [];
    const apply = (doc: Doc, update: Update) => {
      hooks.beforeUpdate?.(name, update);
      Object.assign(doc, update.$set ?? {});
      for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
    };
    return {
      find: (filter: Doc = {}) => {
        const cursor = {
          sort: () => cursor,
          limit: () => cursor,
          toArray: async () => docs().filter((doc) => matches(doc, filter)),
        };
        return cursor;
      },
      findOne: async (filter: Doc) => docs().find((doc) => matches(doc, filter)) ?? null,
      insertOne: async (doc: Doc) => {
        const _id = new ObjectId();
        docs().push({ ...doc, _id });
        return { insertedId: _id };
      },
      updateOne: async (filter: Doc, update: Update) => {
        const doc = docs().find((item) => matches(item, filter));
        if (doc) apply(doc, update);
        return { modifiedCount: doc ? 1 : 0 };
      },
      updateMany: async (filter: Doc, update: Update) => {
        const found = docs().filter((item) => matches(item, filter));
        for (const doc of found) apply(doc, update);
        return { modifiedCount: found.length };
      },
    };
  };
  const session = {
    withTransaction: async (callback: () => Promise<void>) => callback(),
    endSession: async () => {},
  };
  return { collection, client: { startSession: () => session } } as never;
}

const organizerId = new ObjectId();
const eventId = new ObjectId();
const teamId = new ObjectId();
const personId = new ObjectId();
const profileId = new ObjectId();

const requirement = { skill: "ai_ml", target: 3, weight: 3, coverage: { mode: "any_member" } };

function seed(overrides: { unteamed?: boolean; noRequirements?: boolean } = {}) {
  return {
    hackathons: [
      {
        _id: eventId,
        kind: "quick",
        slug: "quick-demo",
        name: "Demo",
        organizerIds: [organizerId],
        capacity: 10,
        collegeAliases: {},
        quotas: [],
        ranking: { requirements: overrides.noRequirements ? [] : [requirement] },
      },
    ],
    teams: [
      {
        _id: teamId,
        hackathonId: eventId,
        name: overrides.unteamed ? "No team — Riya" : "Null Pointers",
        memberIds: [personId],
        status: "submitted",
        submittedAt: new Date("2026-10-01T00:00:00Z"),
        ...(overrides.unteamed ? { unteamed: true } : {}),
      },
    ],
    people: [
      {
        _id: personId,
        name: "Riya Patel",
        email: "riya@example.com",
        github: "riya",
        verified: false,
      },
    ],
    profiles: [
      {
        _id: profileId,
        personId,
        displayName: "Riya Patel",
        status: "ready",
        version: 1,
        repos: [],
        novelty: 0.25,
        flags: [],
        taxonomyVersion: "v2",
        skills: [
          {
            id: "ai_ml",
            level: 4,
            confidence: "high",
            effective: 4,
            evidence: [
              { repository: "riya/leaf", commitSha: "abc1234", path: "train.py", note: "CNN" },
            ],
            thought: "Trains real models",
          },
        ],
      },
    ],
    registrations: [
      { _id: new ObjectId(), hackathonId: eventId, personId, teamId, status: "submitted" },
    ],
    shortlist_runs: [] as Doc[],
    jobs: [] as Doc[],
    audit_entries: [] as Doc[],
  };
}

const runBody = (minTeamSize = 1) => ({
  name: "Run 1",
  params: {
    requirements: [requirement],
    minTeamSize,
    maxTeamSize: 4,
  },
  selection: { capacity: 10, waitlistSize: 0 },
});

function appWith(db: never) {
  const authentication = {
    currentUser: async () => ({ id: organizerId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  app.use(express.json());
  createShortlistApi(db, authentication).register(app);
  return app;
}

const base = `/api/organizer/events/${eventId.toHexString()}/shortlist`;

describe("saved shortlist runs", () => {
  it("export reads the frozen snapshot, so a later profile change does not alter it", async () => {
    const data = seed();
    const app = appWith(fakeDb(data));
    const saved = await request(app).post(`${base}/runs`).send(runBody()).expect(201);
    const runId = saved.body.run.id as string;
    expect(saved.body.run.snapshot.people[0].profile.skills[0].evidence[0].commitSha).toBe(
      "abc1234",
    );

    const before = await request(app).get(`${base}/runs/${runId}.csv`).expect(200);
    expect(before.text).toContain("Riya Patel");
    expect(before.text).toContain("ai_ml");

    Object.assign(data.people[0] as Doc, { name: "Someone Else", email: "new@example.com" });
    Object.assign(data.profiles[0] as Doc, {
      skills: [{ ...data.profiles[0]?.skills[0], id: "backend" }],
    });

    const after = await request(app).get(`${base}/runs/${runId}.csv`).expect(200);
    expect(after.text).toBe(before.text);
    const run = await request(app).get(`${base}/runs/${runId}`).expect(200);
    expect(run.body.run.snapshot.people[0].name).toBe("Riya Patel");
  });

  it("an imported person without a team is ineligible with a stated reason", async () => {
    const data = seed({ unteamed: true });
    const app = appWith(fakeDb(data));
    const saved = await request(app).post(`${base}/runs`).send(runBody(2)).expect(201);
    const result = saved.body.run.results[0];
    expect(result.status).toBe("ineligible");
    expect(result.ineligibleReasons[0]).toBe(UNTEAMED_NOTE);
    const csv = await request(app).get(`${base}/runs/${saved.body.run.id}.csv`).expect(200);
    expect(csv.text).toContain(UNTEAMED_NOTE);
  });
});

describe("audit and drafts", () => {
  it("records the saved run, each override and the publish in the audit log", async () => {
    const data = seed();
    const app = appWith(fakeDb(data));
    const body = runBody();
    const saved = await request(app)
      .post(`${base}/runs`)
      .send({
        ...body,
        selection: {
          ...body.selection,
          overrides: [
            { teamId: teamId.toHexString(), action: "pin_in", reason: "Local problem fit" },
          ],
        },
      })
      .expect(201);
    await request(app).post(`${base}/runs/${saved.body.run.id}/publish`).expect(200);
    expect(data.registrations[0]).toMatchObject({ status: "selected" });
    expect(data.audit_entries.map(({ action, changes, note }) => [action, changes, note])).toEqual([
      ["run.saved", ["Run 1"], undefined],
      ["override.added", ["Null Pointers: pin in"], "Local problem fit"],
      ["run.published", ["Run 1"], undefined],
    ]);
  });

  it("a draft without requirements loads, and saving a run asks for requirements first", async () => {
    const app = appWith(fakeDb(seed({ noRequirements: true })));
    const loaded = await request(app).get(base).expect(200);
    expect(loaded.body.event.ranking.requirements).toEqual([]);
    const saved = await request(app).post(`${base}/runs`).send(runBody()).expect(409);
    expect(saved.body.error).toBe("requirements_missing");
  });
});

describe("publishing", () => {
  it("answers 409 when the one-published-run index rejects a second final run", async () => {
    const data = seed();
    const db = fakeDb(data, {
      beforeUpdate: (name, update) => {
        if (name === "shortlist_runs" && update.$set?.published) {
          throw new MongoServerError({ message: "E11000 duplicate key", code: 11000 });
        }
      },
    });
    const app = appWith(db);
    const saved = await request(app).post(`${base}/runs`).send(runBody()).expect(201);
    const response = await request(app)
      .post(`${base}/runs/${saved.body.run.id}/publish`)
      .expect(409);
    expect(response.body.error).toBe("final_run_exists");
  });

  it("declares a unique index on published runs per event", async () => {
    const declared: Array<{ name: string; indexes: unknown }> = [];
    const db = {
      collection: (name: string) => ({
        createIndexes: async (indexes: unknown) => declared.push({ name, indexes }),
        createIndex: async () => "",
      }),
    } as never;
    await ensureIndexes(db);
    const runIndexes = declared.find((entry) => entry.name === "shortlist_runs")?.indexes;
    expect(runIndexes).toContainEqual({
      key: { hackathonId: 1 },
      name: "one_published_run_per_event",
      unique: true,
      partialFilterExpression: { published: true },
    });
  });
});

describe("failed profile builds", () => {
  it("lists a failure with its error and retries its failed jobs", async () => {
    const data = seed();
    Object.assign(data.profiles[0] as Doc, {
      status: "failed",
      error: "GitHub user @riya was not found",
    });
    data.jobs.push({
      _id: new ObjectId(),
      type: "import_row",
      status: "failed",
      attempts: 3,
      error: "GitHub user @riya was not found",
      payload: { profileId: profileId.toHexString() },
      progress: [],
    });
    const app = appWith(fakeDb(data));
    const listed = await request(app).get(`${base}/failures`).expect(200);
    expect(listed.body.failures).toEqual([
      expect.objectContaining({
        profileId: profileId.toHexString(),
        name: "Riya Patel",
        error: "GitHub user @riya was not found",
      }),
    ]);

    await request(app).post(`${base}/failures/${profileId.toHexString()}/retry`).expect(200);
    expect(data.jobs[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(data.profiles[0]).toMatchObject({ status: "pending" });
    await request(app).post(`${base}/failures/${profileId.toHexString()}/retry`).expect(404);
  });
});

describe("second opinions for borderline teams", () => {
  const secondBase = `${base}/second-opinions`;

  /** Three one-person teams: two nearly tied for the one seat, and one far behind. */
  function seedThree(levels: [number, number, number] = [4.5, 4.4, 1.6]) {
    const data = seed();
    const people = levels.map(() => new ObjectId());
    const teamIds = levels.map(() => new ObjectId());
    const profileIds = levels.map(() => new ObjectId());
    const template = data.profiles[0] as Doc & { skills: Array<Doc> };
    data.teams = levels.map((_, index) => ({
      _id: teamIds[index] as ObjectId,
      hackathonId: eventId,
      name: `Team ${index}`,
      memberIds: [people[index] as ObjectId],
      status: "submitted",
      submittedAt: new Date(`2026-10-0${index + 1}T00:00:00Z`),
    })) as never;
    data.people = levels.map((_, index) => ({
      _id: people[index] as ObjectId,
      name: `Person ${index}`,
      email: `p${index}@example.com`,
      github: `p${index}`,
      verified: false,
    })) as never;
    data.profiles = levels.map((level, index) => ({
      ...template,
      _id: profileIds[index] as ObjectId,
      personId: people[index] as ObjectId,
      displayName: `Person ${index}`,
      assessmentId: new ObjectId(),
      skills: [{ ...(template.skills[0] as Doc), level, effective: level }],
    })) as never;
    data.registrations = [];
    return { data, people, profileIds };
  }

  const body = {
    params: { requirements: [requirement], minTeamSize: 1, maxTeamSize: 4 },
    selection: { capacity: 1, waitlistSize: 0 },
  };

  it("queues a second opinion for members of borderline teams only", async () => {
    const { data, people, profileIds } = seedThree();
    const app = appWith(fakeDb(data));
    const response = await request(app).post(secondBase).send(body).expect(202);

    expect(response.body).toMatchObject({ borderlineTeams: 2, queued: 2, truncated: false });
    const queued = data.jobs.map((job) => job as Doc & { payload: Doc });
    expect(queued.map((job) => job["type"])).toEqual([
      "judge_second_opinion",
      "judge_second_opinion",
    ]);
    expect(queued.map((job) => job.payload["profileId"]).sort()).toEqual(
      [profileIds[0], profileIds[1]].map((id) => (id as ObjectId).toHexString()).sort(),
    );
    expect(queued.map((job) => job.payload["personId"])).not.toContain(
      (people[2] as ObjectId).toHexString(),
    );
    expect(queued[0]?.payload["assessmentId"]).toBe(
      ((data.profiles[0] as Doc)["assessmentId"] as ObjectId).toHexString(),
    );
    expect(data.audit_entries.map(({ action }) => action)).toEqual(["second_opinion.requested"]);
  });

  it("skips profiles that already have a second opinion or are not ready", async () => {
    const { data } = seedThree();
    Object.assign(data.profiles[0] as Doc, { secondAssessmentId: new ObjectId() });
    Object.assign(data.profiles[1] as Doc, { status: "building" });
    const app = appWith(fakeDb(data));
    const response = await request(app).post(secondBase).send(body).expect(202);
    expect(response.body).toMatchObject({ queued: 0, alreadyDone: 1 });
    expect(data.jobs).toEqual([]);
    expect(data.audit_entries).toEqual([]);
  });

  it("leaves teams far from the cutoff alone, even when the cutoff holder is covered", async () => {
    const { data, people } = seedThree([5, 1.5, 1.2]);
    const app = appWith(fakeDb(data));
    const response = await request(app).post(secondBase).send(body).expect(202);
    // Only the team holding the last seat sits on the cutoff; the two far behind are untouched.
    expect(response.body).toMatchObject({ borderlineTeams: 1, queued: 1 });
    const queued = data.jobs.map((job) => (job as Doc & { payload: Doc }).payload["personId"]);
    expect(queued).toEqual([(people[0] as ObjectId).toHexString()]);
  });

  it("asks for requirements first and rejects invalid parameters", async () => {
    const empty = appWith(fakeDb(seed({ noRequirements: true })));
    const missing = await request(empty).post(secondBase).send(body).expect(409);
    expect(missing.body.error).toBe("requirements_missing");
    const app = appWith(fakeDb(seed()));
    await request(app).post(secondBase).send({ params: {} }).expect(422);
  });
});
