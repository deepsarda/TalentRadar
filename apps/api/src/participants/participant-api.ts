import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import express from "express";
import type { Db } from "mongodb";
import { GridFSBucket, ObjectId } from "mongodb";
import { z } from "zod";
import { decryptSecret } from "../auth/crypto.js";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import type {
  HackathonDocument,
  JobDocument,
  PersonDocument,
  ProfileDocument,
  RegistrationDocument,
  UserDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { ApiModule } from "../events/organizer-events.js";
import { enqueueJob } from "../jobs/queue.js";

const GithubRepositorySchema = z.object({
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  name: z.string().min(1),
  description: z.string().nullable(),
  html_url: z.url(),
  default_branch: z.string().min(1),
  fork: z.boolean(),
  archived: z.boolean(),
  size: z.number().int().nonnegative(),
  pushed_at: z.iso.datetime({ offset: true }).nullable(),
  language: z.string().nullable(),
});

const GithubRepositoriesSchema = z.array(GithubRepositorySchema);
const ApplicationSchema = z.object({
  details: z.object({
    name: z.string().trim().min(1).max(120),
    college: z.string().trim().min(1).max(200),
    year: z.string().trim().min(1).max(40),
    branch: z.string().trim().min(1).max(120),
  }),
  repositories: z
    .array(z.string().regex(/^[^/]+\/[^/]+$/))
    .min(1)
    .max(6),
  consent: z.literal(true),
  syntheticCv: z.boolean().default(false),
});

const MAX_CV_BYTES = 2 * 1024 * 1024;
const CV_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GITHUB_API_VERSION = "2026-03-10";

interface RepositoryChoice {
  fullName: string;
  description?: string;
  url: string;
  defaultBranch: string;
  fork: boolean;
  sizeKb: number;
  pushedAt?: string;
  language?: string;
  eligible: boolean;
  exclusionReason?: string;
}

function pdfFileName(value: unknown): string {
  if (typeof value !== "string") return "cv.pdf";
  const decoded = decodeURIComponent(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .slice(0, 120);
  return decoded.toLowerCase().endsWith(".pdf") ? decoded : `${decoded || "cv"}.pdf`;
}

async function currentAccount(
  authentication: Authentication,
  db: Db,
  request: Request,
  response: Response,
): Promise<UserDocument | null> {
  const currentUser = await authentication.currentUser(request);
  if (!currentUser) {
    response.status(401).json({
      error: "authentication_required",
      message: "Sign in with GitHub to use the participant portal",
    });
    return null;
  }
  const account = await db
    .collection<UserDocument>(collections.users)
    .findOne({ _id: ObjectId.createFromHexString(currentUser.id) });
  if (!account) {
    response
      .status(401)
      .json({ error: "account_not_found", message: "Account session is no longer valid" });
    return null;
  }
  return account;
}

async function githubRepositories(
  account: UserDocument,
  sessionSecret: string,
  fetchImplementation: typeof fetch,
): Promise<RepositoryChoice[]> {
  const token = decryptSecret(account.encryptedAccessToken, sessionSecret);
  const response = await fetchImplementation(
    "https://api.github.com/user/repos?per_page=100&sort=pushed&direction=desc&affiliation=owner",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": GITHUB_API_VERSION,
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub repository request failed with ${response.status}`);
  const repositories = GithubRepositoriesSchema.parse(await response.json());
  return repositories.map((repository) => {
    const profileReadme = repository.name.toLowerCase() === account.login.toLowerCase();
    const exclusionReason = repository.archived
      ? "Archived repository"
      : repository.size === 0
        ? "Empty repository"
        : !repository.pushed_at
          ? "Repository has no push timestamp"
          : repository.size > 51_200
            ? "Repository exceeds 50 MB"
            : profileReadme
              ? "GitHub profile README"
              : undefined;
    return {
      fullName: repository.full_name,
      ...(repository.description ? { description: repository.description } : {}),
      url: repository.html_url,
      defaultBranch: repository.default_branch,
      fork: repository.fork,
      sizeKb: repository.size,
      ...(repository.pushed_at ? { pushedAt: repository.pushed_at } : {}),
      ...(repository.language ? { language: repository.language } : {}),
      eligible: !exclusionReason,
      ...(exclusionReason ? { exclusionReason } : {}),
    };
  });
}

function uploadBuffer(
  bucket: GridFSBucket,
  filename: string,
  body: Buffer,
  metadata: object,
): Promise<ObjectId> {
  return new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(filename, {
      metadata: { ...metadata, contentType: "application/pdf" },
    });
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id));
    Readable.from(body).pipe(upload);
  });
}

export function createParticipantApi(
  db: Db,
  authentication: Authentication,
  environment: Environment,
  fetchImplementation: typeof fetch = fetch,
): ApiModule {
  const sessionSecret = environment.SESSION_SECRET;
  if (!sessionSecret) throw new Error("Participant APIs require a session secret");
  const cvBucket = new GridFSBucket(db, { bucketName: "cv" });

  return {
    register(app) {
      app.get("/api/participant/repositories", async (request, response) => {
        const account = await currentAccount(authentication, db, request, response);
        if (!account) return;
        response.json({
          repositories: await githubRepositories(account, sessionSecret, fetchImplementation),
        });
      });

      app.post(
        "/api/participant/cv",
        express.raw({ type: "application/pdf", limit: MAX_CV_BYTES }),
        async (request, response) => {
          const account = await currentAccount(authentication, db, request, response);
          if (!account) return;
          if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
            response
              .status(422)
              .json({ error: "cv_required", message: "Choose a PDF CV to upload" });
            return;
          }
          if (request.body.subarray(0, 5).toString("ascii") !== "%PDF-") {
            response
              .status(415)
              .json({ error: "invalid_pdf", message: "The uploaded file is not a PDF" });
            return;
          }

          const person = await db
            .collection<PersonDocument>(collections.people)
            .findOne({ userId: account._id });
          if (!person) throw new Error("Verified person record is missing");
          const now = new Date();
          const fileId = await uploadBuffer(
            cvBucket,
            pdfFileName(request.headers["x-file-name"]),
            request.body,
            {
              userId: account._id,
              personId: person._id,
              sha256: createHash("sha256").update(request.body).digest("hex"),
              uploadedAt: now,
              expiresAt: new Date(now.getTime() + CV_RETENTION_MS),
            },
          );
          await db
            .collection<PersonDocument>(collections.people)
            .updateOne({ _id: person._id }, { $set: { currentCvFileId: fileId, updatedAt: now } });
          response.status(201).json({
            cv: {
              id: fileId.toHexString(),
              name: pdfFileName(request.headers["x-file-name"]),
              size: request.body.length,
            },
          });
        },
      );

      app.get("/api/participant/overview", async (request, response) => {
        const account = await currentAccount(authentication, db, request, response);
        if (!account) return;
        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId: account._id });
        if (!person) throw new Error("Verified person record is missing");
        const registrations = await db
          .collection<RegistrationDocument>(collections.registrations)
          .find({ personId: person._id })
          .sort({ updatedAt: -1 })
          .toArray();
        const profile = await db
          .collection<ProfileDocument>(collections.profiles)
          .find({ personId: person._id })
          .sort({ version: -1 })
          .limit(1)
          .next();
        const eventIds = registrations.map((registration) => registration.hackathonId);
        const events =
          eventIds.length === 0
            ? []
            : await db
                .collection<HackathonDocument>(collections.hackathons)
                .find({ _id: { $in: eventIds } }, { projection: { name: 1, slug: 1 } })
                .toArray();
        const eventsById = new Map(events.map((event) => [event._id.toHexString(), event]));
        response.json({
          account: {
            name: account.name,
            login: account.login,
            ...(account.college ? { college: account.college } : {}),
            ...(account.year ? { year: account.year } : {}),
            ...(account.branch ? { branch: account.branch } : {}),
            hasCv: Boolean(person.currentCvFileId),
          },
          profile: profile ? { status: profile.status, version: profile.version } : null,
          applications: registrations.map((registration) => ({
            id: registration._id.toHexString(),
            eventId: registration.hackathonId.toHexString(),
            eventName:
              eventsById.get(registration.hackathonId.toHexString())?.name ?? "Unavailable event",
            eventSlug: eventsById.get(registration.hackathonId.toHexString())?.slug,
            status: registration.status,
            updatedAt: registration.updatedAt.toISOString(),
          })),
        });
      });

      app.get("/api/participant/profile", async (request, response) => {
        const account = await currentAccount(authentication, db, request, response);
        if (!account) return;
        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId: account._id });
        if (!person) throw new Error("Verified person record is missing");
        const profile = await db
          .collection<ProfileDocument>(collections.profiles)
          .find({ personId: person._id })
          .sort({ version: -1 })
          .limit(1)
          .next();
        if (!profile) {
          response
            .status(404)
            .json({ error: "profile_not_found", message: "No profile has been started" });
          return;
        }
        const jobs = await db
          .collection<JobDocument>(collections.jobs)
          .find({ "payload.profileId": profile._id.toHexString() })
          .sort({ createdAt: 1 })
          .toArray();
        response.json({
          profile: {
            id: profile._id.toHexString(),
            version: profile.version,
            status: profile.status,
            displayName: profile.displayName,
            repos: profile.repos,
            skills: profile.skills,
            novelty: profile.novelty,
            flags: profile.flags,
            taxonomyVersion: profile.taxonomyVersion,
            builtAt: profile.builtAt?.toISOString(),
            error: profile.error,
          },
          jobs: jobs.map((job) => ({
            id: job._id?.toHexString(),
            type: job.type,
            status: job.status,
            attempts: job.attempts,
            progress: job.progress.map((event) => ({
              at: event.at.toISOString(),
              code: event.code,
              message: event.message,
            })),
            ...(job.error ? { error: job.error } : {}),
          })),
        });
      });

      app.get("/api/participant/applications/:applicationId", async (request, response) => {
        const account = await currentAccount(authentication, db, request, response);
        if (!account) return;
        const applicationId = request.params.applicationId;
        if (!applicationId || !ObjectId.isValid(applicationId)) {
          response
            .status(404)
            .json({ error: "application_not_found", message: "Application not found" });
          return;
        }
        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId: account._id });
        if (!person) throw new Error("Verified person record is missing");
        const application = await db
          .collection<RegistrationDocument>(collections.registrations)
          .findOne({ _id: ObjectId.createFromHexString(applicationId), personId: person._id });
        if (!application) {
          response
            .status(404)
            .json({ error: "application_not_found", message: "Application not found" });
          return;
        }
        const event = await db
          .collection<HackathonDocument>(collections.hackathons)
          .findOne({ _id: application.hackathonId });
        if (!event) {
          response.status(404).json({ error: "event_not_found", message: "Event not found" });
          return;
        }
        response.json({
          application: {
            id: application._id.toHexString(),
            status: application.status,
            lookingForTeam: application.lookingForTeam,
            teamId: application.teamId?.toHexString(),
            updatedAt: application.updatedAt.toISOString(),
            event: {
              id: event._id.toHexString(),
              slug: event.slug,
              name: event.name,
              timeline: event.timeline
                ? {
                    registrationClosesAt: event.timeline.registrationClosesAt.toISOString(),
                    shortlistPublishesAt: event.timeline.shortlistPublishesAt.toISOString(),
                    rsvpDeadlineAt: event.timeline.rsvpDeadlineAt.toISOString(),
                    eventStartsAt: event.timeline.eventStartsAt.toISOString(),
                    timezone: event.timeline.timezone,
                  }
                : null,
            },
          },
        });
      });

      app.post("/api/participant/events/:slug/applications", async (request, response) => {
        const account = await currentAccount(authentication, db, request, response);
        if (!account) return;
        const parsed = ApplicationSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(422).json({
            error: "validation_failed",
            message: "The application is incomplete",
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
          return;
        }
        if (environment.MODEL_DATA_POLICY === "synthetic_only" && !parsed.data.syntheticCv) {
          response.status(422).json({
            error: "synthetic_cv_required",
            message: "This free-tier deployment accepts synthetic CVs only",
          });
          return;
        }

        const now = new Date();
        const event = await db.collection<HackathonDocument>(collections.hackathons).findOne({
          slug: request.params.slug,
          kind: "event",
          visibility: "published",
          "timeline.registrationOpensAt": { $lte: now },
          "timeline.registrationClosesAt": { $gte: now },
        });
        if (!event) {
          response.status(409).json({
            error: "applications_closed",
            message: "This event is not currently accepting applications",
          });
          return;
        }
        const person = await db
          .collection<PersonDocument>(collections.people)
          .findOne({ userId: account._id });
        if (!person?.currentCvFileId) {
          response
            .status(422)
            .json({ error: "cv_required", message: "Upload a PDF CV before applying" });
          return;
        }

        const availableRepositories = await githubRepositories(
          account,
          sessionSecret,
          fetchImplementation,
        );
        const eligibleNames = new Set(
          availableRepositories
            .filter((repository) => repository.eligible)
            .map((repository) => repository.fullName),
        );
        if (parsed.data.repositories.some((repository) => !eligibleNames.has(repository))) {
          response.status(422).json({
            error: "repository_not_eligible",
            message: "One or more selected repositories are unavailable or ineligible",
          });
          return;
        }

        await Promise.all([
          db.collection<UserDocument>(collections.users).updateOne(
            { _id: account._id },
            {
              $set: {
                name: parsed.data.details.name,
                college: parsed.data.details.college,
                year: parsed.data.details.year,
                branch: parsed.data.details.branch,
                updatedAt: now,
              },
            },
          ),
          db.collection<PersonDocument>(collections.people).updateOne(
            { _id: person._id },
            {
              $set: {
                name: parsed.data.details.name,
                college: parsed.data.details.college,
                year: parsed.data.details.year,
                branch: parsed.data.details.branch,
                updatedAt: now,
              },
            },
          ),
        ]);

        const registration = await db
          .collection<RegistrationDocument>(collections.registrations)
          .findOneAndUpdate(
            { hackathonId: event._id, personId: person._id },
            {
              $set: {
                selectedRepositories: parsed.data.repositories,
                cvFileId: person.currentCvFileId,
                consentAt: now,
                status: "draft",
                updatedAt: now,
              },
              $setOnInsert: { lookingForTeam: false, createdAt: now },
            },
            { upsert: true, returnDocument: "after" },
          );
        if (!registration) throw new Error("Application could not be saved");

        const latestProfile = await db
          .collection<ProfileDocument>(collections.profiles)
          .find({ personId: person._id })
          .sort({ version: -1 })
          .limit(1)
          .next();
        const profileId = new ObjectId();
        const profile: ProfileDocument = {
          _id: profileId,
          personId: person._id,
          displayName: parsed.data.details.name,
          status: "pending",
          version: (latestProfile?.version ?? 0) + 1,
          repos: parsed.data.repositories.map((fullName) => ({ fullName, included: true })),
          skills: [],
          novelty: 0,
          flags: [],
          taxonomyVersion: "2",
          createdAt: now,
          updatedAt: now,
        };
        await db.collection<ProfileDocument>(collections.profiles).insertOne(profile);
        const repositoriesByName = new Map(
          availableRepositories.map((repository) => [repository.fullName, repository]),
        );
        await Promise.all([
          ...parsed.data.repositories.map((repository) => {
            const metadata = repositoriesByName.get(repository);
            return enqueueJob(db, "fetch_repo", {
              profileId: profileId.toHexString(),
              personId: person._id.toHexString(),
              repository,
              ...(metadata?.pushedAt ? { pushedAt: metadata.pushedAt } : {}),
              fork: metadata?.fork ?? false,
            });
          }),
          enqueueJob(db, "render_cv", {
            profileId: profileId.toHexString(),
            personId: person._id.toHexString(),
            fileId: person.currentCvFileId.toHexString(),
          }),
        ]);

        response.status(201).json({
          application: { id: registration._id.toHexString(), status: registration.status },
          profile: {
            id: profileId.toHexString(),
            status: profile.status,
            version: profile.version,
          },
        });
      });
    },
  };
}
