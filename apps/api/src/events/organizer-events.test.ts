import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import type { HackathonDocument } from "../database/models.js";
import { diffSummary } from "./audit.js";
import { createOrganizerEventsApi } from "./organizer-events.js";

const organizerId = new ObjectId();

function draftEvent(overrides: Partial<HackathonDocument> = {}): HackathonDocument {
  const now = new Date("2026-10-01T00:00:00Z");
  return {
    _id: new ObjectId(),
    kind: "event",
    slug: "build-night",
    name: "Build Night",
    tagline: "Build something",
    description: "One night.",
    links: [],
    mode: "online",
    organizerIds: [organizerId],
    teamSize: { min: 2, max: 4 },
    capacity: 100,
    requirements: [],
    ranking: {
      requirements: [],
      alpha: 0.7,
      noveltyWeight: 10,
      confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
      minFit: 0,
      minTeamSize: 2,
      maxTeamSize: 4,
    },
    quotas: [],
    collegeAliases: {},
    visibility: "draft",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as HackathonDocument;
}

type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };

/** Applies `$set` (dotted keys too) and `$unset` to a copy, like Mongo would. */
function applyUpdate(document: HackathonDocument, update: Update) {
  const next = { ...document } as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(update.$set ?? {})) {
    const keys = path.split(".");
    let target = next;
    for (const key of keys.slice(0, -1)) {
      target[key] = { ...(target[key] as Record<string, unknown>) };
      target = target[key] as Record<string, unknown>;
    }
    target[keys.at(-1) as string] = value;
  }
  for (const key of Object.keys(update.$unset ?? {})) delete next[key];
  return next as unknown as HackathonDocument;
}

/** One stored event; every write to any collection is recorded as `collection.method`. */
function fakeDb(event: HackathonDocument) {
  let stored = event;
  const writes: string[] = [];
  const audit: unknown[] = [];
  const collection = (name: string) => ({
    findOne: async () => (name === "hackathons" ? stored : null),
    findOneAndUpdate: async (filter: { visibility?: string }, update: Update) => {
      writes.push(`${name}.findOneAndUpdate`);
      if (filter.visibility && filter.visibility !== stored.visibility) return null;
      stored = applyUpdate(stored, update);
      return stored;
    },
    insertOne: async (document: unknown) => {
      writes.push(`${name}.insertOne`);
      if (name === "audit_entries") audit.push(document);
      return { insertedId: new ObjectId() };
    },
    updateOne: async () => writes.push(`${name}.updateOne`),
    updateMany: async () => writes.push(`${name}.updateMany`),
    replaceOne: async () => writes.push(`${name}.replaceOne`),
    deleteOne: async () => writes.push(`${name}.deleteOne`),
    deleteMany: async () => writes.push(`${name}.deleteMany`),
    countDocuments: async () => 0,
    distinct: async () => [],
  });
  return { db: { collection } as never, writes, audit, current: () => stored };
}

function appWith(db: never) {
  const authentication = {
    currentUser: async () => ({ id: organizerId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  app.use(express.json());
  createOrganizerEventsApi(db, authentication).register(app);
  return app;
}

const timeline = {
  timezone: "Asia/Kolkata",
  registrationOpensAt: "2026-11-01T04:30:00.000Z",
  registrationClosesAt: "2026-11-15T18:29:00.000Z",
  shortlistPublishesAt: "2026-11-18T12:30:00.000Z",
  rsvpDeadlineAt: "2026-11-21T18:29:00.000Z",
  eventStartsAt: "2026-11-28T03:30:00.000Z",
  eventEndsAt: "2026-11-29T15:30:00.000Z",
};

describe("event draft steps", () => {
  it("validates each step on its own and stores only that step", async () => {
    const fake = fakeDb(draftEvent());
    const app = appWith(fake.db);
    const path = `/api/organizer/events/${fake.current()._id.toHexString()}/draft`;

    const backwards = { ...timeline, eventEndsAt: "2026-11-01T00:00:00.000Z" };
    await request(app).patch(path).send({ step: "dates", timeline: backwards }).expect(422);
    await request(app)
      .patch(path)
      .send({ step: "teams", teamSize: { min: 4, max: 2 }, capacity: 10 })
      .expect(422);
    await request(app).patch(path).send({ step: "nonsense" }).expect(422);
    expect(fake.writes).toEqual([]);

    const saved = await request(app)
      .patch(path)
      .send({ step: "teams", teamSize: { min: 1, max: 3 }, capacity: 60 })
      .expect(200);
    expect(saved.body.event.capacity).toBe(60);
    expect(fake.current().ranking.maxTeamSize).toBe(3);
    // Still missing dates, so the wizard resumes there.
    expect(saved.body.event.missing).toBe("dates");
  });

  it("refuses draft edits once the event is published", async () => {
    const fake = fakeDb(draftEvent({ visibility: "published" }));
    await request(appWith(fake.db))
      .patch(`/api/organizer/events/${fake.current()._id.toHexString()}/draft`)
      .send({ step: "teams", teamSize: { min: 1, max: 3 }, capacity: 60 })
      .expect(409);
  });

  it("publishes only a complete draft", async () => {
    const fake = fakeDb(draftEvent());
    const app = appWith(fake.db);
    const id = fake.current()._id.toHexString();
    const incomplete = await request(app).post(`/api/organizer/events/${id}/publish`).expect(422);
    expect(incomplete.body.missing).toBe("dates");

    await request(app).patch(`/api/organizer/events/${id}/draft`).send({ step: "dates", timeline });
    await request(app)
      .patch(`/api/organizer/events/${id}/draft`)
      .send({
        step: "requirements",
        requirements: [
          { skill: "backend", target: 3, weight: 2, coverage: { mode: "any_member" } },
        ],
      })
      .expect(200);
    await request(app).post(`/api/organizer/events/${id}/publish`).expect(200);
    expect(fake.current().visibility).toBe("published");
  });
});

describe("organizer audit history", () => {
  it("appends one entry per change and never updates an entry", async () => {
    const fake = fakeDb(draftEvent({ visibility: "published" }));
    const app = appWith(fake.db);
    const path = `/api/organizer/events/${fake.current()._id.toHexString()}/configuration`;
    const body = {
      name: "Build Night",
      tagline: "Build something",
      description: "One night.",
      links: [],
      mode: "online",
      timeline,
      teamSize: { min: 2, max: 4 },
      capacity: 120,
      requirements: [{ skill: "backend", target: 3, weight: 2, coverage: { mode: "any_member" } }],
      quotas: [],
      collegeAliases: {},
    };

    await request(app).patch(path).send(body).expect(200);
    await request(app)
      .patch(path)
      .send({ ...body, capacity: 150 })
      .expect(200);

    expect(fake.audit).toHaveLength(2);
    expect((fake.audit[1] as { changes: string[] }).changes).toEqual(["capacity: 120 → 150"]);
    expect(fake.writes.filter((write) => write.startsWith("audit_entries."))).toEqual([
      "audit_entries.insertOne",
      "audit_entries.insertOne",
    ]);
  });

  it("summarises changes per field", () => {
    expect(
      diffSummary(
        { name: "A", links: [], timeline: { eventStartsAt: new Date("2026-11-28T03:30:00Z") } },
        {
          name: "B",
          links: [{ label: "Discord", url: "https://x.test" }],
          timeline: { eventStartsAt: new Date("2026-11-29T03:30:00Z") },
        },
        ["name", "links", "timeline"],
      ),
    ).toEqual([
      'name: "A" → "B"',
      "links: 0 → 1 items",
      "timeline.eventStartsAt: 2026-11-28 03:30 → 2026-11-29 03:30",
    ]);
  });
});
