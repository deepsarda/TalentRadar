import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import { createParticipantApi } from "./participant-api.js";

const userId = new ObjectId();
const personId = new ObjectId();

function appWithFakeDb() {
  const updates: Array<{ collection: string; filter: unknown; set: unknown }> = [];
  const collection = (name: string) => ({
    findOne: async () =>
      name === "users"
        ? { _id: userId, login: "riya" }
        : name === "people"
          ? { _id: personId, userId }
          : null,
    updateOne: async (filter: unknown, update: { $set: unknown }) => {
      updates.push({ collection: name, filter, set: update.$set });
      return { modifiedCount: 1 };
    },
  });
  const authentication = {
    currentUser: async () => ({ id: userId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  app.use(express.json());
  createParticipantApi({ collection } as never, authentication, {
    SESSION_SECRET: "s".repeat(32),
    GEMINI_MODEL: "m",
  } as Environment).register(app);
  return { app, updates };
}

describe("PATCH /api/participant/details", () => {
  it("remembers details on both the account and the person, before any application", async () => {
    const { app, updates } = appWithFakeDb();
    const details = { name: "Riya Shah", college: "SVNIT", year: "3", branch: "AI" };

    await request(app).patch("/api/participant/details").send(details).expect(200);

    expect(updates.map((update) => update.collection).sort()).toEqual(["people", "users"]);
    for (const update of updates) expect(update.set).toMatchObject(details);
  });

  it("rejects incomplete details without writing anything", async () => {
    const { app, updates } = appWithFakeDb();
    await request(app)
      .patch("/api/participant/details")
      .send({ name: "Riya", college: "", year: "3", branch: "AI" })
      .expect(422);
    expect(updates).toEqual([]);
  });
});
