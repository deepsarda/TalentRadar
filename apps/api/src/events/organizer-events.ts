import { HackathonTimelineSchema, RequirementSchema } from "@talentradar/shared";
import type { Express, Request, Response } from "express";
import type { Db } from "mongodb";
import { MongoServerError, ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type { HackathonDocument, UserDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";

const CreateEventSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    tagline: z.string().trim().min(1).max(140),
    description: z.string().trim().min(1).max(5000),
    logoUrl: z.url().optional(),
    bannerUrl: z.url().optional(),
    links: z
      .array(z.object({ label: z.string().trim().min(1).max(40), url: z.url() }))
      .max(12)
      .default([]),
    mode: z.enum(["in_person", "online", "hybrid"]),
    venue: z.string().trim().max(200).optional(),
    timeline: HackathonTimelineSchema,
    teamSize: z
      .object({ min: z.number().int().min(1).max(6), max: z.number().int().min(1).max(6) })
      .refine((teamSize) => teamSize.min <= teamSize.max, {
        message: "Minimum team size cannot exceed maximum team size",
      }),
    capacity: z.number().int().min(1).max(5000),
    requirements: z.array(RequirementSchema).min(1).max(50),
  })
  .superRefine((event, context) => {
    if (event.mode !== "online" && !event.venue) {
      context.addIssue({
        code: "custom",
        message: "Venue is required for this event mode",
        path: ["venue"],
      });
    }
  });

interface OrganizerEventSummary {
  id: string;
  slug: string;
  name: string;
  visibility: HackathonDocument["visibility"];
  registrationClosesAt?: string;
  eventStartsAt?: string;
  updatedAt: string;
}

export interface ApiModule {
  register(app: Express): void;
}

function summary(event: HackathonDocument): OrganizerEventSummary {
  return {
    id: event._id.toHexString(),
    slug: event.slug,
    name: event.name,
    visibility: event.visibility,
    ...(event.timeline
      ? {
          registrationClosesAt: event.timeline.registrationClosesAt.toISOString(),
          eventStartsAt: event.timeline.eventStartsAt.toISOString(),
        }
      : {}),
    updatedAt: event.updatedAt.toISOString(),
  };
}

function details(
  event: HackathonDocument,
  metrics: { registrations: number; teams: number; profilesReady: number },
) {
  return {
    ...summary(event),
    tagline: event.tagline,
    description: event.description,
    mode: event.mode,
    ...(event.venue ? { venue: event.venue } : {}),
    capacity: event.capacity,
    teamSize: event.teamSize,
    requirements: event.requirements,
    metrics,
    ...(event.timeline
      ? {
          timeline: {
            timezone: event.timeline.timezone,
            registrationOpensAt: event.timeline.registrationOpensAt.toISOString(),
            registrationClosesAt: event.timeline.registrationClosesAt.toISOString(),
            shortlistPublishesAt: event.timeline.shortlistPublishesAt.toISOString(),
            rsvpDeadlineAt: event.timeline.rsvpDeadlineAt.toISOString(),
            eventStartsAt: event.timeline.eventStartsAt.toISOString(),
            eventEndsAt: event.timeline.eventEndsAt.toISOString(),
          },
        }
      : {}),
  };
}

function parseObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? ObjectId.createFromHexString(value) : null;
}

function validationError(response: Response, error: z.ZodError): void {
  response.status(422).json({
    error: "validation_failed",
    message: "Some event fields are invalid",
    fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

export function createOrganizerEventsApi(db: Db, authentication: Authentication): ApiModule {
  const hackathons = db.collection<HackathonDocument>(collections.hackathons);

  async function organizer(request: Request, response: Response): Promise<ObjectId | null> {
    const user = await authentication.currentUser(request);
    if (!user) {
      response.status(401).json({
        error: "authentication_required",
        message: "Sign in with GitHub to use the organizer console",
      });
      return null;
    }
    return ObjectId.createFromHexString(user.id);
  }

  return {
    register(app) {
      app.get("/api/organizer/events", async (request, response) => {
        const organizerId = await organizer(request, response);
        if (!organizerId) return;
        const events = await hackathons
          .find({ organizerIds: organizerId })
          .sort({ updatedAt: -1 })
          .limit(100)
          .toArray();
        response.json({ events: events.map(summary) });
      });

      app.post("/api/organizer/events", async (request, response) => {
        const organizerId = await organizer(request, response);
        if (!organizerId) return;
        const parsed = CreateEventSchema.safeParse(request.body);
        if (!parsed.success) {
          validationError(response, parsed.error);
          return;
        }

        const now = new Date();
        const timeline = {
          timezone: parsed.data.timeline.timezone,
          registrationOpensAt: new Date(parsed.data.timeline.registrationOpensAt),
          registrationClosesAt: new Date(parsed.data.timeline.registrationClosesAt),
          shortlistPublishesAt: new Date(parsed.data.timeline.shortlistPublishesAt),
          rsvpDeadlineAt: new Date(parsed.data.timeline.rsvpDeadlineAt),
          eventStartsAt: new Date(parsed.data.timeline.eventStartsAt),
          eventEndsAt: new Date(parsed.data.timeline.eventEndsAt),
        };
        const document: Omit<HackathonDocument, "_id"> = {
          kind: "event",
          slug: parsed.data.slug,
          name: parsed.data.name,
          tagline: parsed.data.tagline,
          description: parsed.data.description,
          ...(parsed.data.logoUrl ? { logoUrl: parsed.data.logoUrl } : {}),
          ...(parsed.data.bannerUrl ? { bannerUrl: parsed.data.bannerUrl } : {}),
          links: parsed.data.links,
          mode: parsed.data.mode,
          ...(parsed.data.venue ? { venue: parsed.data.venue } : {}),
          organizerIds: [organizerId],
          timeline,
          teamSize: parsed.data.teamSize,
          capacity: parsed.data.capacity,
          requirements: parsed.data.requirements,
          ranking: {
            requirements: parsed.data.requirements,
            alpha: 0.7,
            noveltyWeight: 10,
            minFit: 0,
            minTeamSize: parsed.data.teamSize.min,
            maxTeamSize: parsed.data.teamSize.max,
          },
          quotas: [],
          collegeAliases: {},
          visibility: "draft",
          createdAt: now,
          updatedAt: now,
        };

        try {
          const created = await hackathons.insertOne(document as HackathonDocument);
          await db
            .collection<UserDocument>(collections.users)
            .updateOne(
              { _id: organizerId },
              { $addToSet: { roles: "organizer" }, $set: { updatedAt: now } },
            );
          response.status(201).json({ event: summary({ ...document, _id: created.insertedId }) });
        } catch (error) {
          if (error instanceof MongoServerError && error.code === 11000) {
            response.status(409).json({
              error: "slug_unavailable",
              message: "That public event slug is already in use",
            });
            return;
          }
          throw error;
        }
      });

      app.get("/api/organizer/events/:eventId", async (request, response) => {
        const organizerId = await organizer(request, response);
        if (!organizerId) return;
        const eventId = parseObjectId(request.params.eventId ?? "");
        if (!eventId) {
          response.status(404).json({ error: "event_not_found", message: "Event not found" });
          return;
        }
        const event = await hackathons.findOne({ _id: eventId, organizerIds: organizerId });
        if (!event) {
          response.status(404).json({ error: "event_not_found", message: "Event not found" });
          return;
        }
        const personIds = await db
          .collection(collections.registrations)
          .distinct("personId", { hackathonId: eventId });
        const [registrations, teams, profilesReady] = await Promise.all([
          db.collection(collections.registrations).countDocuments({ hackathonId: eventId }),
          db.collection(collections.teams).countDocuments({ hackathonId: eventId }),
          personIds.length === 0
            ? Promise.resolve(0)
            : db
                .collection(collections.profiles)
                .countDocuments({ personId: { $in: personIds }, status: "ready" }),
        ]);
        response.json({ event: details(event, { registrations, teams, profilesReady }) });
      });

      app.post("/api/organizer/events/:eventId/publish", async (request, response) => {
        const organizerId = await organizer(request, response);
        if (!organizerId) return;
        const eventId = parseObjectId(request.params.eventId ?? "");
        if (!eventId) {
          response.status(404).json({ error: "event_not_found", message: "Event not found" });
          return;
        }
        const now = new Date();
        const event = await hackathons.findOneAndUpdate(
          { _id: eventId, organizerIds: organizerId, visibility: "draft" },
          { $set: { visibility: "published", publishedAt: now, updatedAt: now } },
          { returnDocument: "after" },
        );
        if (!event) {
          response.status(409).json({
            error: "event_not_publishable",
            message: "Only an owned draft event can be published",
          });
          return;
        }
        response.json({ event: summary(event) });
      });
    },
  };
}
