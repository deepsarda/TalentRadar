import type { Express, Request, Response } from "express";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type {
  HackathonDocument,
  HackathonTimelineDocument,
  PersonDocument,
  RegistrationDocument,
  ShortlistRunDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { ApiModule } from "../events/organizer-events.js";
import type { Notice, Notify } from "../notifications/email.js";
import { currentPerson } from "../teams/team-api.js";

/**
 * The application lifecycle after a team is submitted:
 *
 *   submitted ── registration closes ──▶ under_review ── run published ──▶ selected | waitlisted | not_selected
 *   selected ── RSVP ──▶ confirmed | declined      (missing the RSVP deadline counts as declined)
 *   waitlisted ── a seat frees up ──▶ selected     (promotion, by waitlist position, if the team fits)
 *   waitlisted ── event starts ──▶ not_selected
 *
 * under_review is triggered by registration close alone: teams lock then, and from the participant's
 * side nothing else is happening until the result. Tying it to "the organizer saved a run" would
 * expose organizer activity and add nothing a participant can act on.
 *
 * Every transition is a conditional update from the expected previous status, so running any of
 * these functions twice (or from two processes) is safe. Emails go through an outbox:
 * `notifiedStatus` records which status a notice was claimed for, so a status set by any code path
 * (including the shortlist publish endpoint) is announced exactly once by `deliverNotices`.
 */

type Status = RegistrationDocument["status"];

const PRE_DECISION: Status[] = ["submitted", "under_review"];
const SEATED: Status[] = ["selected", "confirmed"];
const NOTIFIED: Status[] = ["selected", "waitlisted", "not_selected", "confirmed"];
/**
 * A team promoted off the waitlist late still gets this long to answer, capped at the event start.
 * Fixed for every event; becomes an organizer setting if anyone asks for a different window.
 */
const PROMOTION_GRACE_MS = 48 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;

const RsvpSchema = z.object({ response: z.enum(["confirm", "decline"]) });

function registrationsOf(db: Db) {
  return db.collection<RegistrationDocument>(collections.registrations);
}

export function effectiveRsvpDeadline(
  registration: Pick<RegistrationDocument, "rsvpDeadlineAt">,
  timeline: HackathonTimelineDocument | undefined,
): Date | null {
  return registration.rsvpDeadlineAt ?? timeline?.rsvpDeadlineAt ?? null;
}

export function promotionDeadline(timeline: HackathonTimelineDocument, now: Date): Date {
  const deadline = Math.max(timeline.rsvpDeadlineAt.getTime(), now.getTime() + PROMOTION_GRACE_MS);
  return new Date(Math.min(deadline, timeline.eventStartsAt.getTime()));
}

/**
 * Which waitlisted teams take the free seats: in waitlist order, skipping any team too big for
 * what is left (the same fill rule as the original selection).
 */
export function planPromotions(
  waitlist: ReadonlyArray<{ teamId: string; position: number; size: number }>,
  freeSeats: number,
): string[] {
  let remaining = freeSeats;
  const promoted: string[] = [];
  for (const team of [...waitlist].sort((left, right) => left.position - right.position)) {
    if (team.size > 0 && team.size <= remaining) {
      promoted.push(team.teamId);
      remaining -= team.size;
    }
  }
  return promoted;
}

async function publishedRun(db: Db, hackathonId: ObjectId) {
  return db
    .collection<ShortlistRunDocument>(collections.shortlistRuns)
    .findOne({ hackathonId, published: true });
}

/**
 * Applies a published run to every undecided application of its event. Safe to call again: only
 * applications still in submitted/under_review change. The shortlist publish endpoint calls this
 * after its transaction; the sweep calls it too, so a crash between the two heals itself.
 */
export async function applyPublishedRun(
  db: Db,
  runId: ObjectId,
  now: Date = new Date(),
): Promise<void> {
  const run = await db
    .collection<ShortlistRunDocument>(collections.shortlistRuns)
    .findOne({ _id: runId, published: true });
  if (!run) return;
  const event = await db
    .collection<HackathonDocument>(collections.hackathons)
    .findOne({ _id: run.hackathonId });
  const registrations = registrationsOf(db);
  for (const result of run.results) {
    const status: Status =
      result.status === "selected"
        ? "selected"
        : result.status === "waitlisted"
          ? "waitlisted"
          : "not_selected";
    const rsvpDeadlineAt = event?.timeline?.rsvpDeadlineAt;
    await registrations.updateMany(
      {
        hackathonId: run.hackathonId,
        teamId: ObjectId.createFromHexString(result.teamId),
        status: { $in: PRE_DECISION },
      },
      {
        $set: {
          status,
          updatedAt: now,
          ...(status === "selected" && rsvpDeadlineAt ? { rsvpDeadlineAt } : {}),
        },
      },
    );
  }
  // The final list is out; a submitted application that is not on it was not selected.
  await registrations.updateMany(
    { hackathonId: run.hackathonId, status: { $in: PRE_DECISION } },
    { $set: { status: "not_selected", updatedAt: now } },
  );
}

/** Fills free seats from the waitlist. Returns the promoted team ids; idempotent. */
export async function promoteFromWaitlist(
  db: Db,
  hackathonId: ObjectId,
  now: Date = new Date(),
): Promise<string[]> {
  const [event, run] = await Promise.all([
    db.collection<HackathonDocument>(collections.hackathons).findOne({ _id: hackathonId }),
    publishedRun(db, hackathonId),
  ]);
  const timeline = event?.timeline;
  if (!timeline || !run || now >= timeline.eventStartsAt) return [];
  const registrations = registrationsOf(db);
  let promoted: string[] = [];
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      // Two promotions for one event write this same document, so one of them conflicts and
      // retries after the other commits: seats can't be handed out twice.
      await db
        .collection<HackathonDocument>(collections.hackathons)
        .updateOne({ _id: hackathonId }, { $set: { updatedAt: now } }, { session });
      const [seated, waiting] = await Promise.all([
        registrations.countDocuments({ hackathonId, status: { $in: SEATED } }, { session }),
        registrations.find({ hackathonId, status: "waitlisted" }, { session }).toArray(),
      ]);
      const waitingByTeam = new Map<string, number>();
      for (const registration of waiting) {
        const teamId = registration.teamId?.toHexString();
        if (teamId) waitingByTeam.set(teamId, (waitingByTeam.get(teamId) ?? 0) + 1);
      }
      promoted = planPromotions(
        run.results.flatMap((result) =>
          result.status === "waitlisted" && result.waitlistPosition !== null
            ? [
                {
                  teamId: result.teamId,
                  position: result.waitlistPosition,
                  size: waitingByTeam.get(result.teamId) ?? 0,
                },
              ]
            : [],
        ),
        run.selection.capacity - seated,
      );
      if (promoted.length === 0) return;
      await registrations.updateMany(
        {
          hackathonId,
          teamId: { $in: promoted.map((id) => ObjectId.createFromHexString(id)) },
          status: "waitlisted",
        },
        {
          $set: {
            status: "selected",
            promotedAt: now,
            rsvpDeadlineAt: promotionDeadline(timeline, now),
            updatedAt: now,
          },
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  return promoted;
}

function noticeKind(registration: RegistrationDocument): Notice["kind"] {
  if (registration.status === "selected") return registration.promotedAt ? "promoted" : "selected";
  if (registration.status === "confirmed") return "rsvp_confirmed";
  if (registration.status === "waitlisted") return "waitlisted";
  return "not_selected";
}

/** Sends one email per status change for an event. A failed send is retried on the next sweep. */
export async function deliverNotices(
  db: Db,
  hackathonId: ObjectId,
  notify: Notify,
  appOrigin?: string,
): Promise<number> {
  const event = await db
    .collection<HackathonDocument>(collections.hackathons)
    .findOne({ _id: hackathonId, kind: "event" });
  if (!event) return 0;
  const registrations = registrationsOf(db);
  const pending = (
    await Promise.all(
      NOTIFIED.map((status) =>
        registrations.find({ hackathonId, status, notifiedStatus: { $ne: status } }).toArray(),
      ),
    )
  ).flat();
  if (pending.length === 0) return 0;
  const people = await db
    .collection<PersonDocument>(collections.people)
    .find({ _id: { $in: pending.map((registration) => registration.personId) } })
    .toArray();
  const peopleById = new Map(people.map((person) => [person._id.toHexString(), person]));
  let sent = 0;
  for (const registration of pending) {
    const previous = registration.notifiedStatus;
    const claimed = await registrations.updateOne(
      {
        _id: registration._id,
        status: registration.status,
        notifiedStatus: previous ?? { $exists: false },
      },
      { $set: { notifiedStatus: registration.status } },
    );
    if (claimed.modifiedCount !== 1) continue;
    const person = peopleById.get(registration.personId.toHexString());
    if (!person?.email) continue;
    const deadline =
      registration.status === "selected"
        ? effectiveRsvpDeadline(registration, event.timeline)
        : null;
    try {
      await notify({
        kind: noticeKind(registration),
        to: person.email,
        name: person.name,
        eventName: event.name,
        ...(appOrigin
          ? {
              statusUrl: `${appOrigin.replace(/\/$/, "")}/participant/applications/${registration._id.toHexString()}`,
            }
          : {}),
        ...(deadline ? { rsvpDeadlineAt: deadline } : {}),
        ...(event.timeline ? { eventStartsAt: event.timeline.eventStartsAt } : {}),
      });
      sent += 1;
    } catch (error) {
      console.error(
        "Notice delivery failed; will retry",
        error instanceof Error ? error.message : "unknown error",
      );
      await registrations.updateOne(
        { _id: registration._id, notifiedStatus: registration.status },
        previous ? { $set: { notifiedStatus: previous } } : { $unset: { notifiedStatus: "" } },
      );
    }
  }
  return sent;
}

/** Time-driven transitions for every event that has not ended yet, then their notices. */
export async function sweepDecisions(
  db: Db,
  notify: Notify,
  appOrigin?: string,
  now: Date = new Date(),
): Promise<void> {
  const events = await db
    .collection<HackathonDocument>(collections.hackathons)
    .find({ kind: "event", "timeline.eventEndsAt": { $gt: now } })
    .toArray();
  const registrations = registrationsOf(db);
  for (const event of events) {
    const timeline = event.timeline;
    if (!timeline) continue;
    const run = await publishedRun(db, event._id);
    if (!run) {
      if (timeline.registrationClosesAt <= now) {
        await registrations.updateMany(
          { hackathonId: event._id, status: "submitted" },
          { $set: { status: "under_review", updatedAt: now } },
        );
      }
    } else {
      await applyPublishedRun(db, run._id, now);
      await registrations.updateMany(
        {
          hackathonId: event._id,
          status: "selected",
          $or: [
            { rsvpDeadlineAt: { $lte: now } },
            ...(timeline.rsvpDeadlineAt <= now ? [{ rsvpDeadlineAt: { $exists: false } }] : []),
          ],
        },
        { $set: { status: "declined", updatedAt: now } },
      );
      if (now >= timeline.eventStartsAt) {
        await registrations.updateMany(
          { hackathonId: event._id, status: "waitlisted" },
          { $set: { status: "not_selected", updatedAt: now } },
        );
      } else {
        await promoteFromWaitlist(db, event._id, now);
      }
    }
    await deliverNotices(db, event._id, notify, appOrigin);
  }
}

/**
 * Runs the sweep every minute in the API process. Several instances may run it at once; every
 * transition is conditional, so that only costs duplicate reads.
 */
export function startDecisionSweep(db: Db, notify: Notify, appOrigin?: string) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepDecisions(db, notify, appOrigin)
      .catch((error) =>
        console.error("Decision sweep failed", error instanceof Error ? error.message : error),
      )
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

export function createDecisionApi(
  db: Db,
  authentication: Authentication,
  notify: Notify,
  appOrigin?: string,
): ApiModule {
  async function ownApplication(request: Request, response: Response, applicationId: string) {
    const person = await currentPerson(authentication, db, request, response);
    if (!person) return null;
    const registration = ObjectId.isValid(applicationId)
      ? await registrationsOf(db).findOne({
          _id: ObjectId.createFromHexString(applicationId),
          personId: person._id,
        })
      : null;
    const event = registration
      ? await db
          .collection<HackathonDocument>(collections.hackathons)
          .findOne({ _id: registration.hackathonId })
      : null;
    if (!registration || !event) {
      response
        .status(404)
        .json({ error: "application_not_found", message: "Application not found" });
      return null;
    }
    return { person, registration, event };
  }

  function rsvpState(registration: RegistrationDocument, event: HackathonDocument, now: Date) {
    const deadline = effectiveRsvpDeadline(registration, event.timeline);
    return {
      status: registration.status,
      rsvpDeadlineAt: deadline?.toISOString() ?? null,
      canRespond: registration.status === "selected" && deadline !== null && now < deadline,
    };
  }

  return {
    register(app: Express) {
      app.get("/api/participant/applications/:applicationId/rsvp", async (request, response) => {
        const owned = await ownApplication(request, response, request.params.applicationId);
        if (!owned) return;
        response.json({ rsvp: rsvpState(owned.registration, owned.event, new Date()) });
      });

      app.post("/api/participant/applications/:applicationId/rsvp", async (request, response) => {
        const owned = await ownApplication(request, response, request.params.applicationId);
        if (!owned) return;
        const parsed = RsvpSchema.safeParse(request.body);
        if (!parsed.success) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Choose confirm or decline" });
          return;
        }
        const now = new Date();
        const { registration, event, person } = owned;
        if (registration.status !== "selected") {
          response.status(409).json({
            error: "rsvp_not_open",
            message: "Only selected applications can confirm or decline",
          });
          return;
        }
        const state = rsvpState(registration, event, now);
        if (!state.canRespond) {
          response
            .status(409)
            .json({ error: "rsvp_closed", message: "The RSVP deadline has passed" });
          return;
        }
        const next: Status = parsed.data.response === "confirm" ? "confirmed" : "declined";
        const updated = await registrationsOf(db).findOneAndUpdate(
          { _id: registration._id, personId: person._id, status: "selected" },
          { $set: { status: next, updatedAt: now } },
          { returnDocument: "after" },
        );
        if (!updated) {
          response
            .status(409)
            .json({ error: "rsvp_conflict", message: "Your status changed; reload the page" });
          return;
        }
        if (next === "declined") await promoteFromWaitlist(db, event._id, now);
        void deliverNotices(db, event._id, notify, appOrigin).catch((error) =>
          console.error("Notice delivery failed", error instanceof Error ? error.message : error),
        );
        response.json({ rsvp: rsvpState(updated, event, now) });
      });
    },
  };
}
