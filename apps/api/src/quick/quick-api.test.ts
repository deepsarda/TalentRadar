import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import {
  createQuickApi,
  groupImportRows,
  normalizeGithub,
  parseCsv,
  suggestedMapping,
} from "./quick-api.js";

describe("Quick Shortlist input parsing", () => {
  it("parses a BOM-prefixed CSV without losing quoted values", () => {
    const parsed = parseCsv(
      Buffer.from('\uFEFFFull Name,Email Address,College\n"Patel, Riya",riya@example.com,SVNIT\n'),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.headers).toEqual(["Full Name", "Email Address", "College"]);
    expect(parsed.rows).toEqual([
      {
        "Full Name": "Patel, Riya",
        "Email Address": "riya@example.com",
        College: "SVNIT",
      },
    ]);
  });

  it("suggests only recognized column mappings", () => {
    expect(
      suggestedMapping(["Participant Name", "E-mail", "GitHub Profile Link", "Unrelated answer"]),
    ).toEqual({
      name: "Participant Name",
      email: "E-mail",
      github: "GitHub Profile Link",
    });
  });

  it("normalizes supported GitHub profile formats", () => {
    expect(normalizeGithub("@riya-dev")).toBe("riya-dev");
    expect(normalizeGithub("https://github.com/riya-dev/")).toBe("riya-dev");
    expect(normalizeGithub("github.com/riya-dev")).toBe("riya-dev");
    expect(normalizeGithub("  ")).toBeUndefined();
  });
});

describe("Quick Shortlist team grouping", () => {
  const rows = [
    { rowNumber: 2, name: "Riya", teamName: "Null  Pointers" },
    { rowNumber: 3, name: "Kabir", teamName: "null pointers" },
    { rowNumber: 4, name: "Isha" },
  ];

  it("keeps a row without a team as an unteamed team of one when solos are not allowed", () => {
    const teams = groupImportRows(rows, 2);
    expect(teams.map((team) => [team.name, team.rows.length, team.unteamed])).toEqual([
      ["Null  Pointers", 2, false],
      ["No team — Isha", 1, true],
    ]);
  });

  it("makes it a normal solo team when the minimum team size is 1", () => {
    expect(groupImportRows(rows, 1)[1]).toMatchObject({ name: "Solo — Isha", unteamed: false });
  });
});

describe("promoting a quick run to an event", () => {
  const ownerId = new ObjectId();
  const quickId = new ObjectId();
  const timeline = {
    timezone: "Asia/Kolkata",
    registrationOpensAt: "2026-11-01T04:30:00Z",
    registrationClosesAt: "2026-11-15T18:29:00Z",
    shortlistPublishesAt: "2026-11-18T12:30:00Z",
    rsvpDeadlineAt: "2026-11-21T18:29:00Z",
    eventStartsAt: "2026-11-28T03:30:00Z",
    eventEndsAt: "2026-11-29T15:30:00Z",
  };

  function appWith(event: { kind: string }) {
    const collection = (name: string) => ({
      findOne: async () =>
        name === "hackathons"
          ? event.kind === "quick"
            ? event
            : null
          : { _id: new ObjectId(), hackathonId: quickId, organizerId: ownerId },
      updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
        Object.assign(event, update.$set);
        return { modifiedCount: 1 };
      },
    });
    const authentication = {
      currentUser: async () => ({ id: ownerId.toHexString() }),
    } as unknown as Authentication;
    const app = express();
    app.use(express.json());
    createQuickApi({ collection } as never, authentication, {
      SESSION_SECRET: "x".repeat(32),
    } as Environment).register(app);
    return app;
  }

  const quick = () => ({
    _id: quickId,
    kind: "quick",
    name: "HackSVNIT 2026",
    organizerIds: [ownerId],
    capacity: 100,
    ranking: {
      requirements: [{ skill: "ai_ml", target: 3, weight: 3, coverage: { mode: "any_member" } }],
      alpha: 0.7,
      noveltyWeight: 10,
      confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
      minFit: 0,
      minTeamSize: 2,
      maxTeamSize: 4,
    },
  });

  it("requires the event fields a quick run lacks", async () => {
    const response = await request(appWith(quick()))
      .post(`/api/organizer/quick/${quickId.toHexString()}/promote`)
      .send({
        slug: "hacksvnit-2026",
        tagline: "36 hours",
        description: "Rules",
        mode: "in_person",
        timeline,
      })
      .expect(422);
    expect(response.body.fields).toContainEqual(expect.objectContaining({ path: "venue" }));
  });

  it("turns the quick run into a draft event with a timeline", async () => {
    const event = quick();
    await request(appWith(event))
      .post(`/api/organizer/quick/${quickId.toHexString()}/promote`)
      .send({
        slug: "hacksvnit-2026",
        tagline: "36 hours",
        description: "Rules",
        mode: "online",
        timeline,
      })
      .expect(200);
    expect(event).toMatchObject({ kind: "event", slug: "hacksvnit-2026", visibility: "draft" });
    expect((event as { timeline?: unknown }).timeline).toMatchObject({
      registrationClosesAt: new Date(timeline.registrationClosesAt),
    });
  });
});
