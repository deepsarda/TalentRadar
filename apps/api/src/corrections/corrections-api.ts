import { SkillIdSchema } from "@talentradar/shared";
import type { Express, Request, Response } from "express";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type {
  CorrectionDocument,
  HackathonDocument,
  PersonDocument,
  ProfileDocument,
  RegistrationDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import { recordAudit } from "../events/audit.js";

/** `.strict()` so a participant cannot name someone else's person or profile. */
const ReportSchema = z
  .object({
    skill: SkillIdSchema,
    reason: z.enum(["not_my_repo", "missing_repo", "level_off"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const ResolveSchema = z.object({
  outcome: z.enum(["resolved", "dismissed"]),
  note: z.string().trim().max(500).optional(),
});

/** Open reports one person may have at once; enough for every skill, not for a flood. */
const MAX_OPEN_PER_PERSON = 30;

function parseObjectId(value: string | undefined): ObjectId | null {
  return value && ObjectId.isValid(value) ? ObjectId.createFromHexString(value) : null;
}

function invalid(response: Response, error: z.ZodError): void {
  response.status(422).json({
    error: "validation_failed",
    message: "Some fields are invalid",
    fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function createCorrectionsApi(db: Db, authentication: Authentication) {
  const corrections = db.collection<CorrectionDocument>(collections.corrections);

  async function signedIn(request: Request, response: Response): Promise<ObjectId | null> {
    const user = await authentication.currentUser(request);
    if (!user) {
      response
        .status(401)
        .json({ error: "authentication_required", message: "Sign in with GitHub first" });
      return null;
    }
    return ObjectId.createFromHexString(user.id);
  }

  /** The organizer's own event, or null after a 401/404. */
  async function ownedEvent(request: Request, response: Response) {
    const organizerId = await signedIn(request, response);
    if (!organizerId) return null;
    const { eventId } = request.params as { eventId?: string };
    const id = parseObjectId(eventId);
    const event = id
      ? await db
          .collection<HackathonDocument>(collections.hackathons)
          .findOne({ _id: id, organizerIds: organizerId }, { projection: { _id: 1 } })
      : null;
    if (!event) {
      response.status(404).json({ error: "event_not_found", message: "Event not found" });
      return null;
    }
    return { organizerId, eventId: event._id };
  }

  return {
    register(app: Express) {
      app.post("/api/participant/profile/corrections", async (request, response) => {
        const userId = await signedIn(request, response);
        if (!userId) return;
        const parsed = ReportSchema.safeParse(request.body);
        if (!parsed.success) {
          invalid(response, parsed.error);
          return;
        }
        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId }, { projection: { _id: 1 } });
        // The newest of the caller's own profiles that shows this skill.
        const profile = person
          ? await db
              .collection<ProfileDocument>(collections.profiles)
              .find({ personId: person._id, "skills.id": parsed.data.skill })
              .sort({ version: -1 })
              .limit(1)
              .next()
          : null;
        if (!person || !profile) {
          response.status(404).json({
            error: "skill_not_found",
            message: "That skill is not on your profile",
          });
          return;
        }
        const open = await corrections.countDocuments({ personId: person._id, status: "open" });
        if (open >= MAX_OPEN_PER_PERSON) {
          response.status(429).json({
            error: "too_many_reports",
            message: "Wait for the organizer to review your reports",
          });
          return;
        }
        const now = new Date();
        const document: Omit<CorrectionDocument, "_id"> = {
          personId: person._id,
          profileId: profile._id,
          profileVersion: profile.version,
          skill: parsed.data.skill,
          reason: parsed.data.reason,
          ...(parsed.data.note ? { note: parsed.data.note } : {}),
          status: "open",
          createdAt: now,
          updatedAt: now,
        };
        const created = await corrections.insertOne(document as CorrectionDocument);
        response.status(201).json({
          correction: {
            id: created.insertedId.toHexString(),
            skill: document.skill,
            reason: document.reason,
            status: document.status,
          },
        });
      });

      app.get("/api/organizer/events/:eventId/corrections", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const personIds = await db
          .collection<RegistrationDocument>(collections.registrations)
          .distinct("personId", { hackathonId: owned.eventId });
        if (personIds.length === 0) {
          response.json({ corrections: [] });
          return;
        }
        const [open, people] = await Promise.all([
          corrections
            .find({ personId: { $in: personIds }, status: "open" })
            .sort({ createdAt: -1 })
            .limit(200)
            .toArray(),
          db
            .collection<PersonDocument>(collections.people)
            .find({ _id: { $in: personIds } }, { projection: { name: 1, github: 1 } })
            .toArray(),
        ]);
        const byId = new Map(people.map((person) => [person._id.toHexString(), person]));
        response.json({
          corrections: open.map((correction) => {
            const person = byId.get(correction.personId.toHexString());
            return {
              id: correction._id.toHexString(),
              personId: correction.personId.toHexString(),
              name: person?.name ?? "Deleted participant",
              github: person?.github ?? "unavailable",
              skill: correction.skill,
              reason: correction.reason,
              ...(correction.note ? { note: correction.note } : {}),
              profileVersion: correction.profileVersion,
              createdAt: correction.createdAt.toISOString(),
            };
          }),
        });
      });

      app.post(
        "/api/organizer/events/:eventId/corrections/:correctionId",
        async (request, response) => {
          const owned = await ownedEvent(request, response);
          if (!owned) return;
          const parsed = ResolveSchema.safeParse(request.body);
          if (!parsed.success) {
            invalid(response, parsed.error);
            return;
          }
          const correctionId = parseObjectId(request.params.correctionId);
          const correction = correctionId
            ? await corrections.findOne({ _id: correctionId, status: "open" })
            : null;
          // Only reports from people registered for this organizer's event are reachable.
          const registered = correction
            ? await db
                .collection<RegistrationDocument>(collections.registrations)
                .findOne(
                  { hackathonId: owned.eventId, personId: correction.personId },
                  { projection: { _id: 1 } },
                )
            : null;
          if (!correction || !registered) {
            response
              .status(404)
              .json({ error: "correction_not_found", message: "No open report with that id" });
            return;
          }
          const now = new Date();
          const note = parsed.data.note || undefined;
          const updated = await corrections.updateOne(
            { _id: correction._id, status: "open" },
            {
              $set: {
                status: parsed.data.outcome,
                resolution: { by: owned.organizerId, at: now, ...(note ? { note } : {}) },
                updatedAt: now,
              },
            },
          );
          if (updated.modifiedCount === 0) {
            response
              .status(409)
              .json({ error: "correction_closed", message: "Someone already handled this" });
            return;
          }
          await recordAudit(db, {
            hackathonId: owned.eventId,
            actorId: owned.organizerId,
            action:
              parsed.data.outcome === "resolved" ? "correction.resolved" : "correction.dismissed",
            changes: [`${correction.skill}: ${correction.reason.replaceAll("_", " ")}`],
            ...(note ? { note } : {}),
          });
          response.json({
            correction: { id: correction._id.toHexString(), status: parsed.data.outcome },
          });
        },
      );
    },
  };
}
