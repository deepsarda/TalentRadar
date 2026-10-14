import type { Request, Response } from "express";
import type { Db } from "mongodb";
import { GridFSBucket, ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import { isSecure, revokeGithubToken, trustedOrigin } from "../auth/github.js";
import { destroyAllSessions } from "../auth/session.js";
import type { Environment } from "../config/environment.js";
import type {
  AssessmentDocument,
  HackathonDocument,
  JobDocument,
  PersonDocument,
  ProfileDocument,
  RegistrationDocument,
  ShortlistRunDocument,
  TeamDocument,
  UserDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { ApiModule } from "../events/organizer-events.js";

/** The subset of GridFSBucket this module uses, so tests can pass a fake bucket. */
export type CvBucket = Pick<GridFSBucket, "find" | "delete">;

export const CV_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const DeletionSchema = z.object({ confirm: z.literal("delete") });

async function signedInUser(
  authentication: Authentication,
  db: Db,
  request: Request,
  response: Response,
): Promise<UserDocument | null> {
  const current = await authentication.currentUser(request);
  const user = current
    ? await db
        .collection<UserDocument>(collections.users)
        .findOne({ _id: ObjectId.createFromHexString(current.id) })
    : null;
  if (!user) {
    response
      .status(401)
      .json({ error: "authentication_required", message: "Sign in with GitHub first" });
    return null;
  }
  return user;
}

/** GridFS delete is idempotent for us: a file another sweep already removed is not an error. */
async function deleteCv(bucket: CvBucket, fileId: ObjectId): Promise<boolean> {
  try {
    await bucket.delete(fileId);
    return true;
  } catch (error) {
    if (error instanceof Error && /file not found/i.test(error.message)) return false;
    throw error;
  }
}

/**
 * Deletes CV files (GridFS files *and* chunks, via the bucket API) 90 days after the last event
 * that uses them, per the spec. A CV no live event references (replaced, never used, or from a
 * Quick Shortlist event without a timeline) goes 90 days after upload. Safe to run concurrently
 * and repeatedly. Ceiling: candidate ids are read into memory in one pass, fine to ~100k files;
 * past that, page by uploadDate.
 */
export async function sweepExpiredCvs(
  db: Db,
  bucket: CvBucket,
  now = new Date(),
): Promise<{ deleted: number; kept: number }> {
  const cutoff = new Date(now.getTime() - CV_RETENTION_MS);
  const candidates = await bucket
    .find({ uploadDate: { $lte: cutoff } }, { projection: { _id: 1 } })
    .toArray();
  if (candidates.length === 0) return { deleted: 0, kept: 0 };
  const candidateIds = candidates.map((file) => file._id);

  const registrations = await db
    .collection<RegistrationDocument>(collections.registrations)
    .find({ cvFileId: { $in: candidateIds } }, { projection: { cvFileId: 1, hackathonId: 1 } })
    .toArray();
  const liveEvents = await db
    .collection<HackathonDocument>(collections.hackathons)
    .find(
      {
        _id: { $in: registrations.map((registration) => registration.hackathonId) },
        "timeline.eventEndsAt": { $gt: cutoff },
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  const liveEventIds = new Set(liveEvents.map((event) => event._id.toHexString()));
  const keep = new Set(
    registrations
      .filter((registration) => liveEventIds.has(registration.hackathonId.toHexString()))
      .flatMap((registration) =>
        registration.cvFileId ? [registration.cvFileId.toHexString()] : [],
      ),
  );

  const expired = candidateIds.filter((id) => !keep.has(id.toHexString()));
  let deleted = 0;
  for (const fileId of expired) if (await deleteCv(bucket, fileId)) deleted += 1;
  if (expired.length > 0) {
    await Promise.all([
      db
        .collection<PersonDocument>(collections.people)
        .updateMany({ currentCvFileId: { $in: expired } }, { $unset: { currentCvFileId: "" } }),
      db
        .collection<RegistrationDocument>(collections.registrations)
        .updateMany({ cvFileId: { $in: expired } }, { $unset: { cvFileId: "" } }),
    ]);
  }
  return { deleted, kept: candidateIds.length - expired.length };
}

function withoutToken(user: UserDocument) {
  const { encryptedAccessToken, ...account } = user;
  return { ...account, githubConnected: encryptedAccessToken !== undefined };
}

export function createDataApi(
  db: Db,
  authentication: Authentication,
  environment: Environment,
  fetchImplementation: typeof fetch = fetch,
  bucket: CvBucket = new GridFSBucket(db, { bucketName: "cv" }),
): ApiModule {
  return {
    register(app) {
      // Everything stored about the signed-in person, and nothing about anyone else: teammates
      // appear only as a member count, and shortlist results without per-member breakdowns.
      app.get("/api/participant/data/export", async (request, response) => {
        const user = await signedInUser(authentication, db, request, response);
        if (!user) return;
        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId: user._id });
        const personId = person?._id;
        const [profiles, assessments, registrations, teams, cvFiles] = personId
          ? await Promise.all([
              db
                .collection<ProfileDocument>(collections.profiles)
                .find({ personId })
                .sort({ version: 1 })
                .toArray(),
              db
                .collection<AssessmentDocument>(collections.assessments)
                .find({ personId })
                .toArray(),
              db
                .collection<RegistrationDocument>(collections.registrations)
                .find({ personId })
                .toArray(),
              db
                .collection<TeamDocument>(collections.teams)
                .find({ memberIds: personId })
                .toArray(),
              bucket.find({ "metadata.personId": personId }).toArray(),
            ])
          : [[], [], [], [], []];
        const eventIds = registrations.map((registration) => registration.hackathonId);
        const [events, runs] =
          eventIds.length === 0
            ? [[], []]
            : await Promise.all([
                db
                  .collection<HackathonDocument>(collections.hackathons)
                  .find({ _id: { $in: eventIds } }, { projection: { name: 1, slug: 1 } })
                  .toArray(),
                db
                  .collection<ShortlistRunDocument>(collections.shortlistRuns)
                  .find({ hackathonId: { $in: eventIds }, published: true })
                  .toArray(),
              ]);
        const eventsById = new Map(events.map((event) => [event._id.toHexString(), event]));
        const teamIds = new Set(teams.map((team) => team._id.toHexString()));

        response.setHeader(
          "content-disposition",
          `attachment; filename="talentradar-data-${user.login.replace(/[^a-zA-Z0-9-]/g, "")}.json"`,
        );
        response.json({
          exportedAt: new Date().toISOString(),
          account: withoutToken(user),
          person,
          profiles,
          assessments,
          applications: registrations.map((registration) => ({
            ...registration,
            event: eventsById.get(registration.hackathonId.toHexString()) ?? null,
          })),
          teams: teams.map((team) => ({
            id: team._id,
            eventId: team.hackathonId,
            name: team.name,
            status: team.status,
            role: personId && team.captainId.equals(personId) ? "captain" : "member",
            memberCount: team.memberIds.length,
            submittedAt: team.submittedAt,
          })),
          reports: runs.flatMap((run) =>
            run.results
              .filter((result) => teamIds.has(result.teamId))
              .map((result) => ({
                eventId: run.hackathonId,
                run: run.name,
                publishedAt: run.publishedAt,
                teamId: result.teamId,
                status: result.status,
                rank: result.rank,
                score: result.score,
                fit: result.fit,
                depth: result.depth,
                novelty: result.novelty,
                waitlistPosition: result.waitlistPosition,
              })),
          ),
          cvFiles: cvFiles.map((file) => ({
            id: file._id,
            filename: file.filename,
            bytes: file.length,
            uploadedAt: file.uploadDate,
            // biome-ignore lint/complexity/useLiteralKeys: GridFS metadata is an index signature.
            sha256: file.metadata?.["sha256"],
          })),
        });
      });

      /**
       * Deletes the account and everything derived from it. Kept, on purpose:
       * - locked teams (locked when a shortlist run is published) keep the member's opaque id, and
       *   published runs keep their frozen results, because the spec never edits a run after
       *   publish so organizers' decisions stay auditable. Neither holds the person's name, which
       *   lived on the deleted people record; screens show "Deleted participant".
       * - draft and submitted teams simply lose the member (captaincy passes to the next member,
       *   an emptied team is deleted), exactly like leaving the team.
       * Order matters: the user and sessions go last, so a failure midway leaves an account that
       * can retry, and every step is idempotent.
       */
      app.post("/api/participant/data/delete", async (request, response) => {
        if (!trustedOrigin(request, environment)) {
          response
            .status(403)
            .json({ error: "untrusted_origin", message: "Request origin is not allowed" });
          return;
        }
        const user = await signedInUser(authentication, db, request, response);
        if (!user) return;
        if (!DeletionSchema.safeParse(request.body).success) {
          response.status(422).json({
            error: "confirmation_required",
            message: 'Type "delete" to confirm account deletion',
          });
          return;
        }
        const organizedEvents = await db
          .collection<HackathonDocument>(collections.hackathons)
          .countDocuments({ organizerIds: user._id });
        if (organizedEvents > 0) {
          response.status(409).json({
            error: "organizer_has_events",
            message: "Hand over or delete your organized events first",
          });
          return;
        }

        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId: user._id });
        const deleted = { teamsLeft: 0, registrations: 0, profiles: 0, assessments: 0, cvFiles: 0 };
        if (person) {
          const teams = db.collection<TeamDocument>(collections.teams);
          for (const team of await teams.find({ memberIds: person._id }).toArray()) {
            if (team.status === "locked") continue;
            const remaining = team.memberIds.filter((memberId) => !memberId.equals(person._id));
            const filter = { _id: team._id, memberIds: person._id, status: team.status };
            const nextCaptain = remaining[0];
            if (!nextCaptain) {
              await teams.deleteOne(filter);
            } else {
              await teams.updateOne(filter, {
                $set: {
                  memberIds: remaining,
                  captainId: team.captainId.equals(person._id) ? nextCaptain : team.captainId,
                  updatedAt: new Date(),
                },
              });
            }
            deleted.teamsLeft += 1;
          }

          const profileIds = (
            await db
              .collection<ProfileDocument>(collections.profiles)
              .find({ personId: person._id }, { projection: { _id: 1 } })
              .toArray()
          ).map((profile) => profile._id.toHexString());
          const [registrations, , assessments] = await Promise.all([
            db
              .collection<RegistrationDocument>(collections.registrations)
              .deleteMany({ personId: person._id }),
            // Job results hold fetched repo excerpts and model reasoning about the person.
            db.collection<JobDocument>(collections.jobs).deleteMany({
              $or: [
                { "payload.personId": person._id.toHexString() },
                { "payload.profileId": { $in: profileIds } },
              ],
            }),
            db
              .collection<AssessmentDocument>(collections.assessments)
              .deleteMany({ personId: person._id }),
          ]);
          const profiles = await db
            .collection<ProfileDocument>(collections.profiles)
            .deleteMany({ personId: person._id });
          deleted.registrations = registrations.deletedCount;
          deleted.assessments = assessments.deletedCount;
          deleted.profiles = profiles.deletedCount;

          for (const file of await bucket.find({ "metadata.personId": person._id }).toArray()) {
            if (await deleteCv(bucket, file._id)) deleted.cvFiles += 1;
          }
          await db.collection<PersonDocument>(collections.people).deleteOne({ _id: person._id });
        }

        // Best effort: the stored token is deleted with the user either way, and the person can
        // still revoke the grant in GitHub settings; the response says which happened.
        let githubRevoked = false;
        try {
          await revokeGithubToken(environment, user.encryptedAccessToken, fetchImplementation);
          githubRevoked = true;
        } catch (error) {
          console.error(
            "GitHub revocation during account deletion failed",
            error instanceof Error ? error.message : "unknown error",
          );
        }
        await destroyAllSessions(db, user._id, response, isSecure(environment));
        await db.collection<UserDocument>(collections.users).deleteOne({ _id: user._id });
        response.json({ deleted, githubRevoked });
      });
    },
  };
}
