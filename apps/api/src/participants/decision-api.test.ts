import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import type { Notice } from "../notifications/email.js";
import {
  applyPublishedRun,
  createDecisionApi,
  deliverNotices,
  planPromotions,
  promoteFromWaitlist,
  sweepDecisions,
} from "./decision-api.js";

interface Row {
  [key: string]: unknown;
  _id?: unknown;
  personId?: unknown;
  teamId?: unknown;
  userId?: unknown;
  status?: unknown;
  published?: unknown;
  rsvpDeadlineAt?: unknown;
  $set?: Row;
  $unset?: Row;
}
type Data = Record<string, Row[]> & {
  registrations: Row[];
  people: Row[];
  shortlist_runs: Row[];
};

function get(row: Row, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Row | undefined)?.[key], row);
}

function same(left: unknown, right: unknown): boolean {
  if (left instanceof ObjectId || right instanceof ObjectId) return String(left) === String(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

/** Just the Mongo query operators the decision module uses. */
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return (condition as Row[]).some((branch) => matches(row, branch));
    const value = get(row, key);
    if (condition && typeof condition === "object" && !(condition instanceof ObjectId)) {
      if (condition instanceof Date) return same(value, condition);
      const ops = condition as Row;
      return Object.entries(ops).every(([op, operand]) => {
        if (op === "$in") return (operand as unknown[]).some((item) => same(value, item));
        if (op === "$ne") return !same(value, operand);
        if (op === "$exists") return (value !== undefined) === operand;
        if (op === "$lte") return (value as Date) <= (operand as Date);
        if (op === "$gt") return (value as Date) > (operand as Date);
        throw new Error(`fake db: unsupported ${op}`);
      });
    }
    if (Array.isArray(value)) return value.some((item) => same(item, condition));
    return same(value, condition);
  });
}

function update(row: Row, change: Row) {
  Object.assign(row, change.$set ?? {});
  for (const key of Object.keys(change.$unset ?? {})) delete row[key];
}

function fakeDb(data: Record<string, Row[]>) {
  const collection = (name: string) => {
    data[name] ??= [];
    const rows = data[name];
    return {
      findOne: async (filter: Row) => {
        const row = rows.find((candidate) => matches(candidate, filter));
        return row ? { ...row } : null;
      },
      find: (filter: Row) => {
        const found = rows.filter((row) => matches(row, filter)).map((row) => ({ ...row }));
        const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => found };
        return cursor;
      },
      countDocuments: async (filter: Row) => rows.filter((row) => matches(row, filter)).length,
      updateOne: async (filter: Row, change: Row) => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (row) update(row, change);
        return { modifiedCount: row ? 1 : 0 };
      },
      updateMany: async (filter: Row, change: Row) => {
        const found = rows.filter((row) => matches(row, filter));
        for (const row of found) update(row, change);
        return { modifiedCount: found.length };
      },
      findOneAndUpdate: async (filter: Row, change: Row) => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (row) update(row, change);
        return row ? { ...row } : null;
      },
    };
  };
  const client = {
    startSession: () => ({
      withTransaction: async (work: () => Promise<void>) => work(),
      endSession: async () => undefined,
    }),
  };
  return { collection, client } as never;
}

const day = 24 * 60 * 60 * 1000;
const publishAt = new Date("2026-11-18T12:30:00Z");
const timeline = {
  timezone: "Asia/Kolkata",
  registrationOpensAt: new Date("2026-11-01T04:30:00Z"),
  registrationClosesAt: new Date("2026-11-15T18:29:00Z"),
  shortlistPublishesAt: publishAt,
  rsvpDeadlineAt: new Date("2026-11-21T18:29:00Z"),
  eventStartsAt: new Date("2026-11-28T03:30:00Z"),
  eventEndsAt: new Date("2026-11-29T15:30:00Z"),
};

/** Capacity 3 seats. Alpha (3) selected; Beta (3) and Gamma (2) waitlisted #1, #2; Delta out. */
function world() {
  const eventId = new ObjectId();
  const runId = new ObjectId();
  const team = (size: number) => ({
    id: new ObjectId(),
    members: [...Array(size)].map(() => new ObjectId()),
  });
  const alpha = team(3);
  const beta = team(3);
  const gamma = team(2);
  const delta = team(2);
  const all = [alpha, beta, gamma, delta];
  const data: Data = {
    hackathons: [{ _id: eventId, kind: "event", name: "HackSVNIT 2026", timeline }],
    shortlist_runs: [
      {
        _id: runId,
        hackathonId: eventId,
        published: true,
        selection: { capacity: 3 },
        results: [
          { teamId: alpha.id.toHexString(), status: "selected", waitlistPosition: null },
          { teamId: beta.id.toHexString(), status: "waitlisted", waitlistPosition: 1 },
          { teamId: gamma.id.toHexString(), status: "waitlisted", waitlistPosition: 2 },
          { teamId: delta.id.toHexString(), status: "not_selected", waitlistPosition: null },
        ],
      },
    ],
    registrations: all.flatMap((t) =>
      t.members.map((personId) => ({
        _id: new ObjectId(),
        hackathonId: eventId,
        personId,
        teamId: t.id,
        status: "under_review",
      })),
    ),
    people: all.flatMap((t) =>
      t.members.map((personId, index) => ({
        _id: personId,
        name: `Member ${index}`,
        email: `${personId.toHexString()}@example.edu`,
      })),
    ),
  };
  const statusOf = (t: { members: ObjectId[] }) =>
    t.members.map(
      (personId) => data.registrations?.find((row) => same(row.personId, personId))?.status,
    );
  return { db: fakeDb(data), data, eventId, runId, alpha, beta, gamma, delta, statusOf };
}

describe("planPromotions", () => {
  it("fills seats in waitlist order, skipping a team that does not fit", () => {
    const waitlist = [
      { teamId: "c", position: 3, size: 1 },
      { teamId: "a", position: 1, size: 4 },
      { teamId: "b", position: 2, size: 2 },
    ];
    expect(planPromotions(waitlist, 3)).toEqual(["b", "c"]);
    expect(planPromotions(waitlist, 0)).toEqual([]);
  });
});

describe("decision lifecycle", () => {
  it("applies a published run once and leaves later changes alone", async () => {
    const w = world();
    await applyPublishedRun(w.db, w.runId, publishAt);
    expect(w.statusOf(w.alpha)).toEqual(["selected", "selected", "selected"]);
    expect(w.statusOf(w.beta)).toEqual(["waitlisted", "waitlisted", "waitlisted"]);
    expect(w.statusOf(w.delta)).toEqual(["not_selected", "not_selected"]);
    const alphaRow = w.data.registrations?.find((row) => same(row.teamId, w.alpha.id));
    expect(alphaRow?.rsvpDeadlineAt).toEqual(timeline.rsvpDeadlineAt);

    if (alphaRow) alphaRow.status = "confirmed";
    await applyPublishedRun(w.db, w.runId, publishAt);
    expect(alphaRow?.status).toBe("confirmed");
  });

  it("promotes the next waitlisted team that fits the freed seats, idempotently", async () => {
    const w = world();
    await applyPublishedRun(w.db, w.runId, publishAt);
    // One Alpha member declines: 1 free seat, nobody fits.
    const [first, second] =
      w.data.registrations?.filter((row) => same(row.teamId, w.alpha.id)) ?? [];
    if (first) first.status = "declined";
    expect(await promoteFromWaitlist(w.db, w.eventId, publishAt)).toEqual([]);
    // A second decline: 2 free seats. Beta (#1, 3 people) doesn't fit; Gamma (#2, 2) does.
    if (second) second.status = "declined";
    const later = new Date(timeline.rsvpDeadlineAt.getTime() - day / 2);
    expect(await promoteFromWaitlist(w.db, w.eventId, later)).toEqual([w.gamma.id.toHexString()]);
    expect(await promoteFromWaitlist(w.db, w.eventId, later)).toEqual([]);
    expect(w.statusOf(w.gamma)).toEqual(["selected", "selected"]);
    const gammaRow = w.data.registrations?.find((row) => same(row.teamId, w.gamma.id));
    // Promoted half a day before the RSVP deadline: gets the 48 h grace instead.
    expect(gammaRow?.rsvpDeadlineAt).toEqual(new Date(later.getTime() + 2 * day));
  });

  it("closes reviews, expires RSVPs, promotes, and ends the waitlist at the start", async () => {
    const w = world();
    const run = w.data.shortlist_runs?.[0];
    if (run) run.published = false;
    for (const row of w.data.registrations ?? []) row.status = "submitted";
    const notices: Notice[] = [];
    const notify = async (notice: Notice) => {
      notices.push(notice);
    };

    await sweepDecisions(
      w.db,
      notify,
      undefined,
      new Date(timeline.registrationClosesAt.getTime() + 1),
    );
    expect(w.statusOf(w.alpha)).toEqual(["under_review", "under_review", "under_review"]);
    expect(notices).toHaveLength(0);

    if (run) run.published = true;
    await sweepDecisions(w.db, notify, "https://tr.example", publishAt);
    expect(notices.map((notice) => notice.kind).sort()).toEqual(
      [
        ...Array(3).fill("selected"),
        ...Array(5).fill("waitlisted"),
        ...Array(2).fill("not_selected"),
      ].sort(),
    );
    expect(notices[0]?.statusUrl).toMatch(/^https:\/\/tr\.example\/participant\/applications\//);

    // Nobody in Alpha answers: at the deadline they are declined and Beta (#1, 3) is promoted.
    notices.length = 0;
    await sweepDecisions(w.db, notify, undefined, new Date(timeline.rsvpDeadlineAt.getTime() + 1));
    expect(w.statusOf(w.alpha)).toEqual(["declined", "declined", "declined"]);
    expect(w.statusOf(w.beta)).toEqual(["selected", "selected", "selected"]);
    expect(w.statusOf(w.gamma)).toEqual(["waitlisted", "waitlisted"]);
    expect(notices.map((notice) => notice.kind)).toEqual(Array(3).fill("promoted"));

    // Re-running sends nothing new.
    notices.length = 0;
    await sweepDecisions(w.db, notify, undefined, new Date(timeline.rsvpDeadlineAt.getTime() + 2));
    expect(notices).toHaveLength(0);
  });

  it("turns the remaining waitlist into not selected when the event starts", async () => {
    const w = world();
    await applyPublishedRun(w.db, w.runId, publishAt);
    await sweepDecisions(w.db, async () => undefined, undefined, timeline.eventStartsAt);
    expect(w.statusOf(w.beta)).toEqual(["not_selected", "not_selected", "not_selected"]);
  });

  it("retries a notice whose delivery failed", async () => {
    const w = world();
    await applyPublishedRun(w.db, w.runId, publishAt);
    let fail = true;
    let delivered = 0;
    const notify = async () => {
      if (fail) throw new Error("smtp down");
      delivered += 1;
    };
    expect(await deliverNotices(w.db, w.eventId, notify)).toBe(0);
    fail = false;
    expect(await deliverNotices(w.db, w.eventId, notify)).toBe(10);
    expect(delivered).toBe(10);
  });
});

describe("RSVP route", () => {
  function appFor(w: ReturnType<typeof world>, personId: ObjectId) {
    const userId = new ObjectId();
    w.data.people?.forEach((person) => {
      if (same(person._id, personId)) person.userId = userId;
    });
    const authentication = {
      currentUser: async () => ({ id: userId.toHexString() }),
    } as unknown as Authentication;
    const app = express();
    app.use(express.json());
    createDecisionApi(w.db, authentication, async () => undefined).register(app);
    return app;
  }

  it("lets a selected participant confirm before the deadline, once", async () => {
    const w = world();
    await applyPublishedRun(w.db, w.runId, publishAt);
    const personId = w.alpha.members[0] as ObjectId;
    const own = w.data.registrations?.find((row) => same(row.personId, personId));
    // The real clock is before the fixture deadline only until 2026-11-21; pin the deadline ahead.
    if (own) own.rsvpDeadlineAt = new Date(Date.now() + day);
    const app = appFor(w, personId);
    const url = `/api/participant/applications/${String(own?._id)}/rsvp`;

    await request(app).post(url).send({ response: "maybe" }).expect(422);
    const confirmed = await request(app).post(url).send({ response: "confirm" }).expect(200);
    expect(confirmed.body.rsvp).toMatchObject({ status: "confirmed", canRespond: false });
    await request(app).post(url).send({ response: "decline" }).expect(409);
  });

  it("rejects other people's applications, waitlisted ones, and late answers", async () => {
    const w = world();
    await applyPublishedRun(w.db, w.runId, publishAt);
    const personId = w.alpha.members[0] as ObjectId;
    const app = appFor(w, personId);
    const own = w.data.registrations?.find((row) => same(row.personId, personId));
    const someoneElse = w.data.registrations?.find((row) => same(row.teamId, w.beta.id));

    await request(app)
      .post(`/api/participant/applications/${String(someoneElse?._id)}/rsvp`)
      .send({ response: "confirm" })
      .expect(404);

    if (own) own.rsvpDeadlineAt = new Date(Date.now() - 1);
    const late = await request(app)
      .post(`/api/participant/applications/${String(own?._id)}/rsvp`)
      .send({ response: "decline" })
      .expect(409);
    expect(late.body.error).toBe("rsvp_closed");

    if (own) own.status = "waitlisted";
    const waitlisted = await request(app)
      .post(`/api/participant/applications/${String(own?._id)}/rsvp`)
      .send({ response: "confirm" })
      .expect(409);
    expect(waitlisted.body.error).toBe("rsvp_not_open");
  });
});
