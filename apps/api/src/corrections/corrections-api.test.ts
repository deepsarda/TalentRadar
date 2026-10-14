import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import { createCorrectionsApi } from "./corrections-api.js";

const userId = new ObjectId();
const ownPerson = new ObjectId();
const otherPerson = new ObjectId();
const ownEvent = new ObjectId();
const correctionId = new ObjectId();

type Row = { _id?: unknown; personId?: unknown; userId?: unknown };

/**
 * The signed-in user owns `ownPerson` and organizes `ownEvent`; `otherPerson` registered only
 * for some other event and filed the one open report.
 */
function fakeDb(queries: Array<[string, Row]>) {
  const collection = (name: string) => ({
    findOne: async (filter: Row) => {
      queries.push([name, filter]);
      if (name === "people") return { _id: ownPerson };
      if (name === "hackathons") {
        return String(filter._id) === ownEvent.toHexString() ? { _id: ownEvent } : null;
      }
      if (name === "corrections") {
        return { _id: correctionId, personId: otherPerson, skill: "backend", reason: "level_off" };
      }
      return null; // registrations: otherPerson is not registered for ownEvent
    },
    find: (filter: Row) => {
      queries.push([name, filter]);
      const rows =
        name === "profiles" ? [{ _id: new ObjectId(), version: 2, personId: ownPerson }] : [];
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        next: async () => rows[0] ?? null,
        toArray: async () => rows,
      };
      return cursor;
    },
    insertOne: async (document: Row) => {
      queries.push([`${name}.insert`, document]);
      return { insertedId: new ObjectId() };
    },
    updateOne: async () => ({ modifiedCount: 1 }),
    countDocuments: async () => 0,
    distinct: async () => [ownPerson],
  });
  return { collection } as never;
}

function appWith(queries: Array<[string, Row]>) {
  const authentication = {
    currentUser: async () => ({ id: userId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  app.use(express.json());
  createCorrectionsApi(fakeDb(queries), authentication).register(app);
  return app;
}

describe("profile corrections ownership", () => {
  it("files a report against the caller's own person only", async () => {
    const queries: Array<[string, Row]> = [];
    const app = appWith(queries);

    await request(app)
      .post("/api/participant/profile/corrections")
      .send({ skill: "backend", reason: "level_off", personId: otherPerson.toHexString() })
      .expect(422);

    await request(app)
      .post("/api/participant/profile/corrections")
      .send({ skill: "backend", reason: "not_my_repo", note: "fork of a friend's repo" })
      .expect(201);
    expect(queries.find(([name]) => name === "people")?.[1]).toEqual({ userId });
    const inserted = queries.find(([name]) => name === "corrections.insert")?.[1];
    expect(inserted?.personId).toEqual(ownPerson);
  });

  it("hides other events and other events' people from an organizer", async () => {
    const queries: Array<[string, Row]> = [];
    const app = appWith(queries);

    await request(app)
      .get(`/api/organizer/events/${new ObjectId().toHexString()}/corrections`)
      .expect(404);
    await request(app)
      .post(`/api/organizer/events/${ownEvent.toHexString()}/corrections/${correctionId}`)
      .send({ outcome: "dismissed" })
      .expect(404);
  });
});
