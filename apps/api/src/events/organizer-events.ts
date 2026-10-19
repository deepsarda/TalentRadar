import {
  HackathonTimelineSchema,
  QuotaRuleSchema,
  RequirementSchema,
  rubricVersion,
  taxonomyVersion,
} from "@talentradar/shared";
import type { Express, Request, Response } from "express";
import type { Db } from "mongodb";
import { MongoServerError, ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type {
  AuditEntryDocument,
  HackathonDocument,
  HackathonTimelineDocument,
  PersonDocument,
  ProfileDocument,
  RegistrationDocument,
  TeamDocument,
  UserDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import { serializeProfile } from "../participants/profile-view.js";
import { diffSummary, listAudit, recordAudit } from "./audit.js";

const LinksSchema = z
  .array(z.object({ label: z.string().trim().min(1).max(40), url: z.url() }))
  .max(12);
const TeamSizeSchema = z
  .object({ min: z.number().int().min(1).max(6), max: z.number().int().min(1).max(6) })
  .refine((teamSize) => teamSize.min <= teamSize.max, {
    message: "Minimum team size cannot exceed maximum team size",
  });
const CapacitySchema = z.number().int().min(1).max(5000);
const QuotasSchema = z.array(QuotaRuleSchema).max(20);
const CollegeAliasesSchema = z.record(
  z.string().trim().min(1).max(200),
  z.array(z.string().trim().min(1).max(200)).max(50),
);

/** Wizard step 1. A draft exists from the moment these are valid. Quick-run promotion reuses them. */
export const detailsFields = {
  name: z.string().trim().min(3).max(80),
  // Spec: lowercase a–z, 0–9 and hyphens; 3–40 characters.
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(3)
    .max(40),
  tagline: z.string().trim().min(1).max(140),
  description: z.string().trim().min(1).max(5000),
  logoUrl: z.url().optional(),
  bannerUrl: z.url().optional(),
  links: LinksSchema.default([]),
  mode: z.enum(["in_person", "online", "hybrid"]),
  venue: z.string().trim().max(200).optional(),
};

export function requireVenue(
  event: { mode: string; venue?: string | undefined },
  context: z.RefinementCtx,
) {
  if (event.mode !== "online" && !event.venue) {
    context.addIssue({
      code: "custom",
      message: "Venue is required for this event mode",
      path: ["venue"],
    });
  }
}

/** Creates a draft from the details step; later steps may come along (all validated) or not. */
const CreateDraftSchema = z
  .object({
    ...detailsFields,
    timeline: HackathonTimelineSchema.optional(),
    teamSize: TeamSizeSchema.default({ min: 2, max: 4 }),
    capacity: CapacitySchema.default(100),
    requirements: z.array(RequirementSchema).max(50).default([]),
    quotas: QuotasSchema.default([]),
    collegeAliases: CollegeAliasesSchema.default({}),
  })
  .superRefine(requireVenue);

/** One wizard step at a time; each step is validated on its own. */
const DraftPatchSchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("details"), ...detailsFields }).superRefine(requireVenue),
  z.object({ step: z.literal("dates"), timeline: HackathonTimelineSchema }),
  z.object({ step: z.literal("teams"), teamSize: TeamSizeSchema, capacity: CapacitySchema }),
  z.object({ step: z.literal("requirements"), requirements: z.array(RequirementSchema).max(50) }),
  z.object({
    step: z.literal("quotas"),
    quotas: QuotasSchema,
    collegeAliases: CollegeAliasesSchema,
  }),
]);

const EventConfigurationSchema = z
  .object({
    name: detailsFields.name,
    tagline: detailsFields.tagline,
    description: detailsFields.description,
    links: LinksSchema,
    mode: detailsFields.mode,
    venue: detailsFields.venue,
    timeline: HackathonTimelineSchema,
    teamSize: TeamSizeSchema,
    capacity: CapacitySchema,
    requirements: z.array(RequirementSchema).min(1).max(50),
    quotas: QuotasSchema,
    collegeAliases: CollegeAliasesSchema,
  })
  .superRefine(requireVenue);

/** Fields an organizer edits; the audit diff covers exactly these. */
const auditedFields = [
  "name",
  "slug",
  "tagline",
  "description",
  "logoUrl",
  "bannerUrl",
  "links",
  "mode",
  "venue",
  "timeline",
  "teamSize",
  "capacity",
  "requirements",
  "quotas",
  "collegeAliases",
] as const;

/** Repeated autosaves of one step by one person within this window share one audit entry. */
const DRAFT_AUDIT_WINDOW_MS = 10 * 60 * 1000;

type SetupMissing = "dates" | "requirements";

/** The first thing a draft still needs before it can be published, or undefined. */
export function setupMissing(event: HackathonDocument): SetupMissing | undefined {
  if (!event.timeline) return "dates";
  if (!event.requirements.some((requirement) => requirement.weight > 0)) return "requirements";
  return undefined;
}

function toTimeline(timeline: z.infer<typeof HackathonTimelineSchema>) {
  return {
    timezone: timeline.timezone,
    registrationOpensAt: new Date(timeline.registrationOpensAt),
    registrationClosesAt: new Date(timeline.registrationClosesAt),
    shortlistPublishesAt: new Date(timeline.shortlistPublishesAt),
    rsvpDeadlineAt: new Date(timeline.rsvpDeadlineAt),
    eventStartsAt: new Date(timeline.eventStartsAt),
    eventEndsAt: new Date(timeline.eventEndsAt),
  };
}

function timelineToIso(timeline: HackathonTimelineDocument) {
  return {
    timezone: timeline.timezone,
    registrationOpensAt: timeline.registrationOpensAt.toISOString(),
    registrationClosesAt: timeline.registrationClosesAt.toISOString(),
    shortlistPublishesAt: timeline.shortlistPublishesAt.toISOString(),
    rsvpDeadlineAt: timeline.rsvpDeadlineAt.toISOString(),
    eventStartsAt: timeline.eventStartsAt.toISOString(),
    eventEndsAt: timeline.eventEndsAt.toISOString(),
  };
}

interface OrganizerEventSummary {
  id: string;
  kind: HackathonDocument["kind"];
  slug: string;
  name: string;
  visibility: HackathonDocument["visibility"];
  /** Drafts only: the first step still needed before publishing. */
  missing?: SetupMissing;
  registrationClosesAt?: string;
  eventStartsAt?: string;
  updatedAt: string;
}

export interface ApiModule {
  register(app: Express): void;
}

function summary(event: HackathonDocument): OrganizerEventSummary {
  const missing = event.visibility === "draft" ? setupMissing(event) : undefined;
  return {
    id: event._id.toHexString(),
    kind: event.kind,
    slug: event.slug,
    name: event.name,
    visibility: event.visibility,
    ...(missing ? { missing } : {}),
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
    ...(event.logoUrl ? { logoUrl: event.logoUrl } : {}),
    ...(event.bannerUrl ? { bannerUrl: event.bannerUrl } : {}),
    links: event.links,
    mode: event.mode,
    ...(event.venue ? { venue: event.venue } : {}),
    capacity: event.capacity,
    teamSize: event.teamSize,
    requirements: event.requirements,
    quotas: event.quotas,
    collegeAliases: event.collegeAliases,
    metrics,
    ...(event.timeline ? { timeline: timelineToIso(event.timeline) } : {}),
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

function eventNotFound(response: Response): void {
  response.status(404).json({ error: "event_not_found", message: "Event not found" });
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function slugUnavailable(response: Response): void {
  response.status(409).json({
    error: "slug_unavailable",
    message: "That public event slug is already in use",
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

  /** The organizer and their event, or null after answering 401/404. */
  async function ownedEvent(request: Request, response: Response) {
    const organizerId = await organizer(request, response);
    if (!organizerId) return null;
    const { eventId: eventIdText } = request.params as { eventId?: string };
    const eventId = parseObjectId(eventIdText ?? "");
    const event = eventId
      ? await hackathons.findOne({ _id: eventId, organizerIds: organizerId })
      : null;
    if (!event) {
      eventNotFound(response);
      return null;
    }
    return { organizerId, event };
  }

  async function metrics(eventId: ObjectId) {
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
    return { registrations, teams, profilesReady };
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
        const parsed = CreateDraftSchema.safeParse(request.body);
        if (!parsed.success) {
          validationError(response, parsed.error);
          return;
        }

        const now = new Date();
        const input = parsed.data;
        const document: Omit<HackathonDocument, "_id"> = {
          kind: "event",
          slug: input.slug,
          name: input.name,
          tagline: input.tagline,
          description: input.description,
          ...(input.logoUrl ? { logoUrl: input.logoUrl } : {}),
          ...(input.bannerUrl ? { bannerUrl: input.bannerUrl } : {}),
          links: input.links,
          mode: input.mode,
          ...(input.venue ? { venue: input.venue } : {}),
          organizerIds: [organizerId],
          ...(input.timeline ? { timeline: toTimeline(input.timeline) } : {}),
          teamSize: input.teamSize,
          capacity: input.capacity,
          requirements: input.requirements,
          // Requirements name taxonomy ids and targets on a rubric scale; keep which versions.
          taxonomyVersion,
          rubricVersion,
          ranking: {
            requirements: input.requirements,
            alpha: 0.7,
            noveltyWeight: 10,
            confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
            minFit: 0,
            minTeamSize: input.teamSize.min,
            maxTeamSize: input.teamSize.max,
          },
          quotas: input.quotas,
          collegeAliases: input.collegeAliases,
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
          await recordAudit(db, {
            hackathonId: created.insertedId,
            actorId: organizerId,
            action: "event.created",
          });
          response.status(201).json({ event: summary({ ...document, _id: created.insertedId }) });
        } catch (error) {
          if (isDuplicateKey(error)) {
            slugUnavailable(response);
            return;
          }
          throw error;
        }
      });

      app.get("/api/organizer/events/:eventId", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        response.json({ event: details(owned.event, await metrics(owned.event._id)) });
      });

      /** Saves one wizard step of a draft. Valid progress is stored as soon as it is valid. */
      app.patch("/api/organizer/events/:eventId/draft", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const { organizerId, event: existing } = owned;
        if (existing.visibility !== "draft") {
          response.status(409).json({
            error: "event_not_draft",
            message: "Published events are edited in settings",
          });
          return;
        }
        const parsed = DraftPatchSchema.safeParse(request.body);
        if (!parsed.success) {
          validationError(response, parsed.error);
          return;
        }
        const input = parsed.data;
        const now = new Date();
        const set: Partial<HackathonDocument> & Record<string, unknown> = { updatedAt: now };
        const unset: Record<string, ""> = {};
        if (input.step === "details") {
          Object.assign(set, {
            name: input.name,
            slug: input.slug,
            tagline: input.tagline,
            description: input.description,
            links: input.links,
            mode: input.mode,
          });
          for (const key of ["logoUrl", "bannerUrl", "venue"] as const) {
            if (input[key]) set[key] = input[key];
            else unset[key] = "";
          }
        } else if (input.step === "dates") {
          set.timeline = toTimeline(input.timeline);
        } else if (input.step === "teams") {
          set.teamSize = input.teamSize;
          set.capacity = input.capacity;
          set["ranking.minTeamSize"] = input.teamSize.min;
          set["ranking.maxTeamSize"] = input.teamSize.max;
        } else if (input.step === "requirements") {
          set.requirements = input.requirements;
          set["ranking.requirements"] = input.requirements;
          set.taxonomyVersion = taxonomyVersion;
          set.rubricVersion = rubricVersion;
        } else {
          set.quotas = input.quotas;
          set.collegeAliases = input.collegeAliases;
        }

        let event: HackathonDocument | null;
        try {
          event = await hackathons.findOneAndUpdate(
            { _id: existing._id, organizerIds: organizerId, visibility: "draft" },
            { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
            { returnDocument: "after" },
          );
        } catch (error) {
          if (isDuplicateKey(error)) {
            slugUnavailable(response);
            return;
          }
          throw error;
        }
        if (!event) {
          response.status(409).json({
            error: "event_not_draft",
            message: "Published events are edited in settings",
          });
          return;
        }

        const changes = diffSummary(
          existing as unknown as Record<string, unknown>,
          event as unknown as Record<string, unknown>,
          auditedFields,
        );
        if (changes.length) {
          // Ceiling: autosave fires every few seconds while someone types, so one person's saves
          // of one step inside DRAFT_AUDIT_WINDOW_MS keep only the first entry. Drafts have no
          // public page or registrations yet; published events log every change in full.
          const recent = await db.collection<AuditEntryDocument>(collections.auditEntries).findOne(
            {
              hackathonId: event._id,
              actorId: organizerId,
              action: "draft.saved",
              note: input.step,
              at: { $gte: new Date(now.getTime() - DRAFT_AUDIT_WINDOW_MS) },
            },
            { sort: { at: -1 } },
          );
          if (!recent) {
            await recordAudit(db, {
              hackathonId: event._id,
              actorId: organizerId,
              action: "draft.saved",
              note: input.step,
              changes,
            });
          }
        }
        response.json({ event: details(event, await metrics(event._id)) });
      });

      app.post("/api/organizer/events/:eventId/publish", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const { organizerId, event: existing } = owned;
        if (existing.visibility !== "draft") {
          response.status(409).json({
            error: "event_not_publishable",
            message: "Only an owned draft event can be published",
          });
          return;
        }
        const missing = setupMissing(existing);
        if (missing) {
          response.status(422).json({
            error: "event_incomplete",
            message: missing === "dates" ? "Add the event dates first" : "Weight one skill first",
            missing,
          });
          return;
        }
        // Full validation of the stored document, not just the steps that were saved.
        const complete = EventConfigurationSchema.safeParse({
          name: existing.name,
          tagline: existing.tagline,
          description: existing.description,
          links: existing.links,
          mode: existing.mode,
          ...(existing.venue ? { venue: existing.venue } : {}),
          timeline: existing.timeline ? timelineToIso(existing.timeline) : undefined,
          teamSize: existing.teamSize,
          capacity: existing.capacity,
          requirements: existing.requirements,
          quotas: existing.quotas,
          collegeAliases: existing.collegeAliases,
        });
        if (!complete.success) {
          validationError(response, complete.error);
          return;
        }
        const now = new Date();
        const event = await hackathons.findOneAndUpdate(
          { _id: existing._id, organizerIds: organizerId, visibility: "draft" },
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
        await recordAudit(db, {
          hackathonId: event._id,
          actorId: organizerId,
          action: "event.published",
          changes: [`public page /h/${event.slug}`],
        });
        response.json({ event: summary(event) });
      });

      /** Back to draft, only while nobody has registered and no shortlist is published. */
      app.post("/api/organizer/events/:eventId/unpublish", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const { organizerId, event: existing } = owned;
        const [registrations, publishedRun] = await Promise.all([
          db.collection(collections.registrations).countDocuments({ hackathonId: existing._id }),
          db
            .collection(collections.shortlistRuns)
            .findOne({ hackathonId: existing._id, published: true }),
        ]);
        if (existing.visibility !== "published" || registrations > 0 || publishedRun) {
          response.status(409).json({
            error: "event_not_unpublishable",
            message: "Only a published event without registrations can be unpublished",
          });
          return;
        }
        const event = await hackathons.findOneAndUpdate(
          { _id: existing._id, organizerIds: organizerId, visibility: "published" },
          { $set: { visibility: "draft", updatedAt: new Date() }, $unset: { publishedAt: "" } },
          { returnDocument: "after" },
        );
        if (!event) {
          response.status(409).json({
            error: "event_not_unpublishable",
            message: "Only a published event without registrations can be unpublished",
          });
          return;
        }
        await recordAudit(db, {
          hackathonId: event._id,
          actorId: organizerId,
          action: "event.unpublished",
        });
        response.json({ event: summary(event) });
      });

      app.get("/api/organizer/events/:eventId/audit", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const entries = await listAudit(db, owned.event._id);
        const actorIds = [...new Set(entries.map((entry) => entry.actorId.toHexString()))].map(
          (id) => ObjectId.createFromHexString(id),
        );
        const actors = actorIds.length
          ? await db
              .collection<UserDocument>(collections.users)
              .find({ _id: { $in: actorIds } }, { projection: { login: 1 } })
              .toArray()
          : [];
        const logins = new Map(actors.map((actor) => [actor._id.toHexString(), actor.login]));
        response.json({
          entries: entries.map((entry) => ({
            id: entry._id.toHexString(),
            action: entry.action,
            actor: logins.get(entry.actorId.toHexString()) ?? "unknown",
            changes: entry.changes,
            ...(entry.note ? { note: entry.note } : {}),
            at: entry.at.toISOString(),
          })),
        });
      });

      app.get(
        "/api/organizer/events/:eventId/participants/:personId/profile",
        async (request, response) => {
          const owned = await ownedEvent(request, response);
          if (!owned) return;
          const personId = parseObjectId(request.params.personId ?? "");
          const registration = personId
            ? await db.collection<RegistrationDocument>(collections.registrations).findOne({
                hackathonId: owned.event._id,
                personId,
              })
            : null;
          if (!registration || !personId) {
            response.status(404).json({
              error: "participant_not_found",
              message: "Participant not found in this event",
            });
            return;
          }
          const [person, profile] = await Promise.all([
            db.collection<PersonDocument>(collections.people).findOne({ _id: personId }),
            db
              .collection<ProfileDocument>(collections.profiles)
              .find({ personId })
              .sort({ version: -1 })
              .limit(1)
              .next(),
          ]);
          if (!person) {
            response
              .status(404)
              .json({ error: "participant_not_found", message: "Participant not found" });
            return;
          }
          response.json({
            person: {
              personId: personId.toHexString(),
              name: person.name,
              github: person.github,
              college: person.college,
              year: person.year,
              branch: person.branch,
            },
            profile: profile ? await serializeProfile(db, profile) : null,
          });
        },
      );

      app.get("/api/organizer/events/:eventId/operations", async (request, response) => {
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
        const [registrations, teams] = await Promise.all([
          db
            .collection<RegistrationDocument>(collections.registrations)
            .find({ hackathonId: eventId })
            .sort({ updatedAt: -1 })
            .toArray(),
          db
            .collection<TeamDocument>(collections.teams)
            .find({ hackathonId: eventId })
            .sort({ updatedAt: -1 })
            .toArray(),
        ]);
        const personIds = [
          ...new Set(registrations.map((registration) => registration.personId.toHexString())),
        ].map((id) => ObjectId.createFromHexString(id));
        const [people, profiles] = await Promise.all([
          personIds.length
            ? db
                .collection<PersonDocument>(collections.people)
                .find({ _id: { $in: personIds } })
                .toArray()
            : Promise.resolve([]),
          personIds.length
            ? db
                .collection<ProfileDocument>(collections.profiles)
                .find({ personId: { $in: personIds } })
                .sort({ personId: 1, version: -1 })
                .toArray()
            : Promise.resolve([]),
        ]);
        const peopleById = new Map(people.map((person) => [person._id.toHexString(), person]));
        const profilesByPerson = new Map<string, ProfileDocument>();
        for (const profile of profiles) {
          const personId = profile.personId.toHexString();
          if (!profilesByPerson.has(personId)) profilesByPerson.set(personId, profile);
        }
        const member = (personId: ObjectId) => {
          const id = personId.toHexString();
          const person = peopleById.get(id);
          const profile = profilesByPerson.get(id);
          return {
            id,
            name: person?.name ?? "Deleted participant",
            github: person?.github ?? "unavailable",
            ...(person?.college ? { college: person.college } : {}),
            profileStatus: profile?.status ?? "pending",
            topSkills: profile?.skills.slice(0, 3).map((skill) => skill.id) ?? [],
          };
        };
        response.json({
          participants: registrations.map((registration) => {
            const id = registration.personId.toHexString();
            const person = peopleById.get(id);
            const profile = profilesByPerson.get(id);
            return {
              registrationId: registration._id.toHexString(),
              personId: id,
              name: person?.name ?? "Deleted participant",
              github: person?.github ?? "unavailable",
              ...(person?.email ? { email: person.email } : {}),
              verified: person?.verified ?? false,
              ...(person?.college ? { college: person.college } : {}),
              ...(person?.year ? { year: person.year } : {}),
              ...(person?.branch ? { branch: person.branch } : {}),
              status: registration.status,
              lookingForTeam: registration.lookingForTeam,
              teamId: registration.teamId?.toHexString(),
              profileStatus: profile?.status ?? "pending",
              profileVersion: profile?.version,
              topSkills: profile?.skills.slice(0, 3).map((skill) => skill.id) ?? [],
              updatedAt: registration.updatedAt.toISOString(),
            };
          }),
          teams: teams.map((team) => ({
            id: team._id.toHexString(),
            name: team.name,
            status: team.status,
            captainId: team.captainId.toHexString(),
            submittedAt: team.submittedAt?.toISOString(),
            members: team.memberIds.map(member),
          })),
        });
      });

      app.patch("/api/organizer/events/:eventId/configuration", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const { organizerId, event: existing } = owned;
        const parsed = EventConfigurationSchema.safeParse(request.body);
        if (!parsed.success) {
          validationError(response, parsed.error);
          return;
        }
        const publishedRun = await db
          .collection(collections.shortlistRuns)
          .findOne({ hackathonId: existing._id, published: true });
        if (publishedRun) {
          response.status(409).json({
            error: "event_locked",
            message: "A published shortlist locks the event configuration",
          });
          return;
        }
        const now = new Date();
        const event = await hackathons.findOneAndUpdate(
          { _id: existing._id, organizerIds: organizerId },
          {
            $set: {
              name: parsed.data.name,
              tagline: parsed.data.tagline,
              description: parsed.data.description,
              links: parsed.data.links,
              mode: parsed.data.mode,
              ...(parsed.data.venue ? { venue: parsed.data.venue } : {}),
              timeline: toTimeline(parsed.data.timeline),
              teamSize: parsed.data.teamSize,
              capacity: parsed.data.capacity,
              requirements: parsed.data.requirements,
              taxonomyVersion,
              rubricVersion,
              quotas: parsed.data.quotas,
              collegeAliases: parsed.data.collegeAliases,
              ranking: {
                ...existing.ranking,
                requirements: parsed.data.requirements,
                minTeamSize: parsed.data.teamSize.min,
                maxTeamSize: parsed.data.teamSize.max,
              },
              updatedAt: now,
            },
            ...(parsed.data.venue ? {} : { $unset: { venue: "" } }),
          },
          { returnDocument: "after" },
        );
        if (!event) throw new Error("Updated event disappeared");
        const changes = diffSummary(
          existing as unknown as Record<string, unknown>,
          event as unknown as Record<string, unknown>,
          auditedFields,
        );
        if (changes.length) {
          await recordAudit(db, {
            hackathonId: event._id,
            actorId: organizerId,
            action: "event.updated",
            changes,
          });
        }
        response.json({ event: details(event, await metrics(event._id)) });
      });
    },
  };
}
