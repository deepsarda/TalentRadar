import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import { createDataApi, sweepExpiredCvs } from "./data-api.js";

interface Doc {
  _id?: unknown;
  files_id?: unknown;
  memberIds?: unknown;
  captainId?: unknown;
  cvFileId?: unknown;
  currentCvFileId?: unknown;
  [key: string]: unknown;
}
type Name =
  | "users"
  | "people"
  | "profiles"
  | "assessments"
  | "jobs"
  | "registrations"
  | "hackathons"
  | "teams"
  | "shortlist_runs"
  | "sessions"
  | "cv.files"
  | "cv.chunks";
type Data = Partial<Record<Name, Doc[]>>;
interface Operators {
  $in?: unknown[];
  $gt?: Date;
  $lte?: Date;
}

function field(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Doc | undefined)?.[key], doc);
}
function same(left: unknown, right: unknown): boolean {
  if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}
/** Just the query operators the module uses: equality, array membership, $in, $gt, $lte, $or. */
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return (condition as Doc[]).some((branch) => matches(doc, branch));
    const value = field(doc, key);
    const values = Array.isArray(value) ? value : [value];
    if (condition && typeof condition === "object" && !(condition instanceof ObjectId)) {
      const { $in, $gt, $lte } = condition as Operators;
      if ($in) return values.some((item) => $in.some((candidate) => same(item, candidate)));
      if ($gt) return value instanceof Date && value > $gt;
      if ($lte) return value instanceof Date && value <= $lte;
    }
    return values.some((item) => same(item, condition));
  });
}

/** An in-memory Db: enough of find/findOne/update/delete for this module, nothing more. */
function memoryDb(data: Data) {
  const rows = (name: Name): Doc[] => {
    data[name] ??= [];
    return data[name];
  };
  const cursor = (items: Doc[]) => ({
    sort: () => cursor(items),
    limit: () => cursor(items),
    toArray: async () => items,
  });
  const collection = (name: Name) => ({
    find: (filter: Doc = {}) => cursor(rows(name).filter((doc) => matches(doc, filter))),
    findOne: async (filter: Doc) => rows(name).find((doc) => matches(doc, filter)) ?? null,
    countDocuments: async (filter: Doc) => rows(name).filter((doc) => matches(doc, filter)).length,
    updateOne: async (filter: Doc, update: { $set?: Doc }) => {
      const doc = rows(name).find((item) => matches(item, filter));
      if (doc) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    },
    updateMany: async (filter: Doc, update: { $unset?: Doc }) => {
      for (const doc of rows(name).filter((item) => matches(item, filter))) {
        for (const key of Object.keys(update.$unset ?? {})) delete doc[key];
      }
      return {};
    },
    deleteOne: async (filter: Doc) => {
      const index = rows(name).findIndex((doc) => matches(doc, filter));
      if (index >= 0) rows(name).splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    deleteMany: async (filter: Doc) => {
      const before = rows(name).length;
      data[name] = rows(name).filter((doc) => !matches(doc, filter));
      return { deletedCount: before - rows(name).length };
    },
  });
  return { collection } as never;
}

/** A fake GridFS bucket: delete removes the file and its chunks, and throws once it is gone. */
function memoryBucket(data: Data) {
  return {
    find: (filter: Doc = {}) => ({
      toArray: async () => (data["cv.files"] ?? []).filter((doc) => matches(doc, filter)),
    }),
    delete: async (id: ObjectId) => {
      const files = data["cv.files"] ?? [];
      if (!files.some((file) => same(file._id, id))) throw new Error(`File not found for id ${id}`);
      data["cv.files"] = files.filter((file) => !same(file._id, id));
      data["cv.chunks"] = (data["cv.chunks"] ?? []).filter((chunk) => !same(chunk.files_id, id));
    },
  } as never;
}

const environment = {
  APP_ORIGIN: "http://app.test",
  GITHUB_CLIENT_ID: "client",
  GITHUB_CLIENT_SECRET: "secret",
  SESSION_SECRET: "s".repeat(32),
} as Environment;

function world() {
  const me = { user: new ObjectId(), person: new ObjectId() };
  const other = { user: new ObjectId(), person: new ObjectId() };
  const event = new ObjectId();
  const draftTeam = new ObjectId();
  const lockedTeam = new ObjectId();
  const soloTeam = new ObjectId();
  const otherTeam = new ObjectId();
  const myCv = new ObjectId();
  const otherCv = new ObjectId();
  const myProfile = new ObjectId();
  const data: Data = {
    users: [
      // Not a real encrypted token: revocation is skipped for an account without one.
      { _id: me.user, login: "riya", name: "Riya", roles: ["participant"] },
      { _id: other.user, login: "kabir", name: "Kabir", roles: ["participant"] },
    ],
    people: [
      { _id: me.person, userId: me.user, name: "Riya", github: "riya" },
      { _id: other.person, userId: other.user, name: "Kabir", github: "kabir" },
    ],
    profiles: [
      { _id: myProfile, personId: me.person, version: 1, displayName: "Riya" },
      { _id: new ObjectId(), personId: other.person, version: 1, displayName: "Kabir" },
    ],
    assessments: [
      { _id: new ObjectId(), personId: me.person, cacheKey: "a" },
      { _id: new ObjectId(), personId: other.person, cacheKey: "b" },
    ],
    jobs: [
      { _id: new ObjectId(), payload: { profileId: myProfile.toHexString() } },
      { _id: new ObjectId(), payload: { personId: other.person.toHexString() } },
    ],
    registrations: [
      { _id: new ObjectId(), personId: me.person, hackathonId: event, cvFileId: myCv },
      { _id: new ObjectId(), personId: other.person, hackathonId: event, cvFileId: otherCv },
    ],
    hackathons: [{ _id: event, name: "Hack", slug: "hack", organizerIds: [new ObjectId()] }],
    teams: [
      {
        _id: draftTeam,
        hackathonId: event,
        name: "Draft",
        status: "draft",
        captainId: me.person,
        memberIds: [me.person, other.person],
      },
      {
        _id: lockedTeam,
        hackathonId: event,
        name: "Locked",
        status: "locked",
        captainId: other.person,
        memberIds: [other.person, me.person],
      },
      {
        _id: soloTeam,
        hackathonId: event,
        name: "Solo",
        status: "submitted",
        captainId: me.person,
        memberIds: [me.person],
      },
      {
        _id: otherTeam,
        hackathonId: event,
        name: "Theirs",
        status: "draft",
        captainId: other.person,
        memberIds: [other.person],
      },
    ],
    shortlist_runs: [
      {
        _id: new ObjectId(),
        hackathonId: event,
        name: "Final",
        published: true,
        results: [
          { teamId: draftTeam.toHexString(), rank: 1, status: "selected", breakdown: ["x"] },
          { teamId: otherTeam.toHexString(), rank: 2, status: "waitlisted", breakdown: [] },
        ],
      },
    ],
    sessions: [
      { _id: "mine", userId: me.user },
      { _id: "theirs", userId: other.user },
    ],
    "cv.files": [
      { _id: myCv, filename: "riya.pdf", metadata: { personId: me.person, sha256: "aa" } },
      { _id: otherCv, filename: "kabir.pdf", metadata: { personId: other.person } },
    ],
    "cv.chunks": [
      { _id: new ObjectId(), files_id: myCv },
      { _id: new ObjectId(), files_id: otherCv },
    ],
  };
  const authentication = {
    currentUser: async () => ({ id: me.user.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  app.use(express.json());
  const noFetch = (async () => {
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  createDataApi(memoryDb(data), authentication, environment, noFetch, memoryBucket(data)).register(
    app,
  );
  return { app, data, me, other, draftTeam, lockedTeam, soloTeam, otherTeam, otherCv };
}

describe("participant data export", () => {
  it("contains the signed-in person's data and none of anyone else's", async () => {
    const { app, other } = world();
    const response = await request(app).get("/api/participant/data/export").expect(200);
    expect(response.headers["content-disposition"]).toContain("talentradar-data-riya.json");
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(other.person.toHexString());
    expect(body).not.toContain("Kabir");
    expect(body).not.toContain("kabir.pdf");
    expect(response.body.account.encryptedAccessToken).toBeUndefined();
    expect(response.body.profiles).toHaveLength(1);
    expect(response.body.assessments).toHaveLength(1);
    expect(response.body.teams.map((team: { name: string }) => team.name).sort()).toEqual([
      "Draft",
      "Locked",
      "Solo",
    ]);
    // Only their own team's result, without the per-member breakdown.
    expect(response.body.reports).toEqual([
      expect.objectContaining({ run: "Final", rank: 1, status: "selected" }),
    ]);
    expect(response.body.reports[0].breakdown).toBeUndefined();
  });
});

describe("account deletion", () => {
  it("refuses without the typed confirmation", async () => {
    const { app, data } = world();
    await request(app).post("/api/participant/data/delete").send({ confirm: "yes" }).expect(422);
    expect(data.users).toHaveLength(2);
  });

  it("refuses requests from another origin", async () => {
    const { app } = world();
    await request(app)
      .post("/api/participant/data/delete")
      .set("origin", "http://evil.test")
      .send({ confirm: "delete" })
      .expect(403);
  });

  it("deletes exactly the person's data and keeps locked-team snapshots", async () => {
    const { app, data, me, other, draftTeam, lockedTeam, soloTeam, otherTeam, otherCv } = world();
    const response = await request(app)
      .post("/api/participant/data/delete")
      .send({ confirm: "delete" })
      .expect(200);
    expect(response.body.deleted).toEqual({
      teamsLeft: 2,
      registrations: 1,
      profiles: 1,
      assessments: 1,
      cvFiles: 1,
    });
    expect(response.headers["set-cookie"]?.[0]).toContain("Max-Age=0");

    const ids = (name: Name) => (data[name] ?? []).map((doc) => String(doc._id));
    expect(ids("users")).toEqual([other.user.toHexString()]);
    expect(ids("people")).toEqual([other.person.toHexString()]);
    expect(ids("sessions")).toEqual(["theirs"]);
    expect(data.profiles).toHaveLength(1);
    expect(data.assessments).toHaveLength(1);
    expect(data.jobs).toHaveLength(1);
    expect(data.registrations).toHaveLength(1);
    expect(ids("cv.files")).toEqual([otherCv.toHexString()]);
    expect(data["cv.chunks"]?.map((chunk) => String(chunk.files_id))).toEqual([
      otherCv.toHexString(),
    ]);

    const team = (id: ObjectId) => data.teams?.find((doc) => same(doc._id, id));
    // Draft team: member removed, captaincy passed on.
    expect(team(draftTeam)?.memberIds).toEqual([other.person]);
    expect(team(draftTeam)?.captainId).toEqual(other.person);
    // Emptied team is gone; the other person's team is untouched.
    expect(team(soloTeam)).toBeUndefined();
    expect(team(otherTeam)?.memberIds).toEqual([other.person]);
    // Locked (published) team keeps its frozen membership.
    expect(team(lockedTeam)?.memberIds).toEqual([other.person, me.person]);
    expect(data.shortlist_runs).toHaveLength(1);
  });
});

describe("CV retention sweep", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date("2026-10-15T00:00:00Z");

  function sweepWorld() {
    const recentEvent = new ObjectId();
    const oldEvent = new ObjectId();
    const fresh = new ObjectId();
    const liveEventCv = new ObjectId();
    const oldEventCv = new ObjectId();
    const orphan = new ObjectId();
    const uploaded = (days: number) => new Date(now.getTime() - days * day);
    const data: Data = {
      "cv.files": [
        { _id: fresh, uploadDate: uploaded(10) },
        { _id: liveEventCv, uploadDate: uploaded(200) },
        { _id: oldEventCv, uploadDate: uploaded(200) },
        { _id: orphan, uploadDate: uploaded(120) },
      ],
      "cv.chunks": [fresh, liveEventCv, oldEventCv, orphan].map((id) => ({ files_id: id })),
      hackathons: [
        { _id: recentEvent, timeline: { eventEndsAt: uploaded(30) } },
        { _id: oldEvent, timeline: { eventEndsAt: uploaded(100) } },
      ],
      registrations: [
        { _id: new ObjectId(), hackathonId: recentEvent, cvFileId: liveEventCv },
        { _id: new ObjectId(), hackathonId: oldEvent, cvFileId: oldEventCv },
      ],
      people: [{ _id: new ObjectId(), currentCvFileId: orphan }],
    };
    return { data, fresh, liveEventCv, oldEventCv, orphan };
  }

  it("deletes files and chunks 90 days after the last event, and is idempotent", async () => {
    const { data, fresh, liveEventCv } = sweepWorld();
    const db = memoryDb(data);
    const bucket = memoryBucket(data);
    expect(await sweepExpiredCvs(db, bucket, now)).toEqual({ deleted: 2, kept: 1 });
    const remaining = [fresh, liveEventCv].map(String);
    expect(data["cv.files"]?.map((file) => String(file._id))).toEqual(remaining);
    expect(data["cv.chunks"]?.map((chunk) => String(chunk.files_id))).toEqual(remaining);
    expect(data.people?.[0]?.currentCvFileId).toBeUndefined();
    expect(data.registrations?.[1]?.cvFileId).toBeUndefined();
    expect(await sweepExpiredCvs(db, bucket, now)).toEqual({ deleted: 0, kept: 1 });
  });

  it("treats a file another sweep removed first as already done", async () => {
    const { data, oldEventCv } = sweepWorld();
    const bucket = memoryBucket(data);
    const racing = {
      find: (bucket as { find: unknown }).find,
      delete: async (id: ObjectId) => {
        if (same(id, oldEventCv))
          await (bucket as { delete(id: ObjectId): Promise<void> }).delete(id);
        return (bucket as { delete(id: ObjectId): Promise<void> }).delete(id);
      },
    } as never;
    expect(await sweepExpiredCvs(memoryDb(data), racing, now)).toEqual({ deleted: 1, kept: 1 });
  });
});
