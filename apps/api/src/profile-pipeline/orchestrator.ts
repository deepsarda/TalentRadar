import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { JobDocument, ProfileDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import { type ClaimedJob, enqueueJob } from "../jobs/queue.js";

const ProfilePayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
});

function stringProperty(
  record: Readonly<Record<string, unknown>> | undefined,
  property: string,
): string | undefined {
  const value = record?.[property];
  return typeof value === "string" ? value : undefined;
}

/**
 * Chains the profile stages. `completed` runs after a job is marked done and is retried by the
 * worker's follow-up sweep if it fails or the process dies, so it must stay idempotent: every
 * next stage is enqueued with a (profile, stage) dedupe key, which the unique index enforces even
 * when two workers finish the last two input jobs at the same moment.
 */
export function createProfileOrchestrator(db: Db) {
  return {
    async completed(job: ClaimedJob, result?: Record<string, unknown>): Promise<void> {
      const parsed = ProfilePayloadSchema.safeParse(job.payload);
      if (!parsed.success) return;
      const { profileId, personId } = parsed.data;

      if (job.type === "fetch_repo" || job.type === "render_cv") {
        const profile = await db
          .collection<ProfileDocument>(collections.profiles)
          .findOne({ _id: ObjectId.createFromHexString(profileId) });
        if (!profile) return;
        const inputJobs = await db
          .collection<JobDocument>(collections.jobs)
          .find({ "payload.profileId": profileId, type: { $in: ["fetch_repo", "render_cv"] } })
          .toArray();
        const fetchJobs = inputJobs.filter((inputJob) => inputJob.type === "fetch_repo");
        const renderJobs = inputJobs.filter((inputJob) => inputJob.type === "render_cv");
        if (
          fetchJobs.length !== profile.repos.length ||
          renderJobs.length > 1 ||
          inputJobs.some((inputJob) => inputJob.status !== "done")
        ) {
          return;
        }
        const fileId = stringProperty(renderJobs[0]?.payload, "fileId");
        if (renderJobs.length === 1 && !fileId) {
          throw new Error("Rendered CV job has no file id");
        }
        await db
          .collection<ProfileDocument>(collections.profiles)
          .updateOne(
            { _id: profile._id, status: "pending" },
            { $set: { status: "building", updatedAt: new Date() } },
          );
        await enqueueJob(
          db,
          "judge_person",
          { profileId, personId, ...(fileId ? { fileId } : {}) },
          { maxAttempts: 3, dedupeKey: `${profileId}:judge_person` },
        );
        return;
      }

      if (job.type === "judge_person") {
        const assessmentId = stringProperty(result, "assessmentId");
        if (!assessmentId) throw new Error("Judge job produced no assessment id");
        await enqueueJob(
          db,
          "aggregate_profile",
          { profileId, personId, assessmentId },
          { maxAttempts: 1, dedupeKey: `${profileId}:aggregate_profile` },
        );
        return;
      }

      if (job.type === "judge_second_opinion") {
        // A skipped job (the profile was rebuilt meanwhile) has nothing to merge.
        if (result?.["skipped"]) return;
        const assessmentId = stringProperty(result, "assessmentId");
        const secondAssessmentId = stringProperty(result, "secondAssessmentId");
        if (!assessmentId || !secondAssessmentId) {
          throw new Error("Second-opinion job produced no assessment ids");
        }
        // One re-aggregation per second assessment; the first aggregation's key is already used.
        await enqueueJob(
          db,
          "aggregate_profile",
          { profileId, personId, assessmentId, secondAssessmentId },
          { maxAttempts: 1, dedupeKey: `${profileId}:aggregate_profile:${secondAssessmentId}` },
        );
      }
    },

    async failed(job: ClaimedJob, error: string): Promise<void> {
      const parsed = ProfilePayloadSchema.safeParse(job.payload);
      if (!parsed.success) return;
      await db.collection<ProfileDocument>(collections.profiles).updateOne(
        { _id: ObjectId.createFromHexString(parsed.data.profileId), status: { $ne: "ready" } },
        {
          $set: {
            status: "failed",
            error: error.slice(0, 1000),
            updatedAt: new Date(),
          },
        },
      );
    },
  };
}
