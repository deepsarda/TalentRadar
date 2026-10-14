import type { Requirement } from "@talentradar/shared";
import type { Db } from "mongodb";
import type { HackathonDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";

export interface PublicEvent {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  registrationClosesAt: string;
  eventStartsAt: string;
  eventEndsAt: string;
  timezone: string;
  registrationOpensAt: string;
  shortlistPublishesAt: string;
  rsvpDeadlineAt: string;
  teamSize: { min: number; max: number };
  capacity: number;
  requirements: Requirement[];
  links: Array<{ label: string; url: string }>;
  status: "upcoming" | "open" | "closed";
}

export interface PublicEventRepository {
  list(): Promise<PublicEvent[]>;
  findBySlug(slug: string): Promise<PublicEvent | null>;
}

function eventStatus(
  now: Date,
  timeline: NonNullable<HackathonDocument["timeline"]>,
): PublicEvent["status"] {
  if (now < timeline.registrationOpensAt) return "upcoming";
  if (now <= timeline.registrationClosesAt) return "open";
  return "closed";
}

function toPublicEvent(document: HackathonDocument, now: Date): PublicEvent | null {
  if (!document.timeline || document.kind !== "event") return null;
  return {
    id: document._id.toHexString(),
    slug: document.slug,
    name: document.name,
    tagline: document.tagline,
    description: document.description,
    mode: document.mode,
    ...(document.venue ? { venue: document.venue } : {}),
    registrationClosesAt: document.timeline.registrationClosesAt.toISOString(),
    eventStartsAt: document.timeline.eventStartsAt.toISOString(),
    eventEndsAt: document.timeline.eventEndsAt.toISOString(),
    timezone: document.timeline.timezone,
    registrationOpensAt: document.timeline.registrationOpensAt.toISOString(),
    shortlistPublishesAt: document.timeline.shortlistPublishesAt.toISOString(),
    rsvpDeadlineAt: document.timeline.rsvpDeadlineAt.toISOString(),
    teamSize: document.teamSize,
    capacity: document.capacity,
    requirements: document.requirements,
    links: document.links,
    status: eventStatus(now, document.timeline),
  };
}

export function createMongoPublicEventRepository(db: Db): PublicEventRepository {
  const hackathons = db.collection<HackathonDocument>(collections.hackathons);
  return {
    async list() {
      const now = new Date();
      const documents = await hackathons
        .find({
          kind: "event",
          visibility: { $in: ["published", "closed"] },
          timeline: { $exists: true },
        })
        .sort({ "timeline.eventStartsAt": 1 })
        .limit(100)
        .toArray();
      return documents.flatMap((document) => {
        const event = toPublicEvent(document, now);
        return event ? [event] : [];
      });
    },

    async findBySlug(slug) {
      const document = await hackathons.findOne({
        slug,
        kind: "event",
        visibility: { $in: ["published", "closed"] },
        timeline: { $exists: true },
      });
      return document ? toPublicEvent(document, new Date()) : null;
    },
  };
}
