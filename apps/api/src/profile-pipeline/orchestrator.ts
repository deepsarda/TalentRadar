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
        const existingJudge = await db.collection<JobDocument>(collections.jobs).findOne({
          "payload.profileId": profileId,
          type: "judge_person",
        });
        if (existingJudge) return;
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
          { maxAttempts: 3 },
        );
        return;
      }

      if (job.type === "judge_person") {
        const assessmentId = stringProperty(result, "assessmentId");
        if (!assessmentId) throw new Error("Judge job produced no assessment id");
        const existingAggregate = await db.collection<JobDocument>(collections.jobs).findOne({
          "payload.profileId": profileId,
          type: "aggregate_profile",
        });
        if (!existingAggregate) {
          await enqueueJob(
            db,
            "aggregate_profile",
            { profileId, personId, assessmentId },
            { maxAttempts: 1 },
          );
        }
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
