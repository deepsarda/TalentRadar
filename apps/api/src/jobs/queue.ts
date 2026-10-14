import type { Db, ObjectId } from "mongodb";
import type { JobDocument, JobProgressEvent, JobType } from "../database/models.js";
import { collections } from "../database/mongo.js";

const MAX_PROGRESS_EVENTS = 200;

export interface EnqueueJobOptions {
  maxAttempts?: number;
  runAt?: Date;
}

export type ClaimedJob = JobDocument & { _id: ObjectId };

export async function enqueueJob(
  db: Db,
  type: JobType,
  payload: Record<string, unknown>,
  options: EnqueueJobOptions = {},
): Promise<ObjectId> {
  const now = new Date();
  const job: JobDocument = {
    type,
    payload,
    status: "queued",
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 3,
    runAt: options.runAt ?? now,
    progress: [],
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection<JobDocument>(collections.jobs).insertOne(job);
  return result.insertedId;
}

export async function claimJob(
  db: Db,
  workerId: string,
  acceptedTypes: JobType[],
  leaseMs: number,
): Promise<ClaimedJob | null> {
  if (acceptedTypes.length === 0) return null;
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const event: JobProgressEvent = {
    at: now,
    code: "job.claimed",
    message: "Worker claimed this job",
  };

  return db.collection<JobDocument>(collections.jobs).findOneAndUpdate(
    {
      type: { $in: acceptedTypes },
      runAt: { $lte: now },
      $expr: { $lt: ["$attempts", "$maxAttempts"] },
      $or: [{ status: "queued" }, { status: "running", lockedUntil: { $lte: now } }],
    },
    {
      $set: {
        status: "running",
        lockedBy: workerId,
        lockedUntil: leaseUntil,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
      $push: { progress: { $each: [event], $slice: -MAX_PROGRESS_EVENTS } },
    },
    { sort: { runAt: 1, createdAt: 1 }, returnDocument: "after" },
  );
}

export async function renewJobLease(
  db: Db,
  jobId: ObjectId,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const now = new Date();
  const result = await db
    .collection<JobDocument>(collections.jobs)
    .updateOne(
      { _id: jobId, status: "running", lockedBy: workerId, lockedUntil: { $gt: now } },
      { $set: { lockedUntil: new Date(now.getTime() + leaseMs), updatedAt: now } },
    );
  return result.modifiedCount === 1;
}

export async function appendJobProgress(
  db: Db,
  jobId: ObjectId,
  workerId: string,
  code: string,
  message: string,
): Promise<boolean> {
  const now = new Date();
  const event: JobProgressEvent = { at: now, code, message };
  const result = await db.collection<JobDocument>(collections.jobs).updateOne(
    { _id: jobId, status: "running", lockedBy: workerId },
    {
      $set: { updatedAt: now },
      $push: { progress: { $each: [event], $slice: -MAX_PROGRESS_EVENTS } },
    },
  );
  return result.modifiedCount === 1;
}

export async function completeJob(
  db: Db,
  jobId: ObjectId,
  workerId: string,
  jobResult?: Record<string, unknown>,
): Promise<boolean> {
  const now = new Date();
  const updateResult = await db.collection<JobDocument>(collections.jobs).updateOne(
    { _id: jobId, status: "running", lockedBy: workerId },
    {
      $set: {
        status: "done",
        completedAt: now,
        updatedAt: now,
        ...(jobResult ? { result: jobResult } : {}),
      },
      $unset: { lockedBy: "", lockedUntil: "", error: "" },
      $push: {
        progress: {
          $each: [{ at: now, code: "job.completed", message: "Job completed" }],
          $slice: -MAX_PROGRESS_EVENTS,
        },
      },
    },
  );
  return updateResult.modifiedCount === 1;
}

export function retryDelayMs(attempt: number, random = Math.random): number {
  const exponential = Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export async function failJob(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  error: string,
  delayMs = retryDelayMs(job.attempts),
): Promise<boolean> {
  const now = new Date();
  const terminal = job.attempts >= job.maxAttempts;
  const status = terminal ? "failed" : "queued";
  const event: JobProgressEvent = {
    at: now,
    code: terminal ? "job.failed" : "job.retry_scheduled",
    message: terminal
      ? "Job failed after all attempts"
      : "Job will retry after a recoverable failure",
  };
  const result = await db.collection<JobDocument>(collections.jobs).updateOne(
    { _id: job._id, status: "running", lockedBy: workerId },
    {
      $set: {
        status,
        error: error.slice(0, 2000),
        runAt: terminal ? now : new Date(now.getTime() + delayMs),
        updatedAt: now,
        ...(terminal ? { completedAt: now } : {}),
      },
      $unset: { lockedBy: "", lockedUntil: "" },
      $push: { progress: { $each: [event], $slice: -MAX_PROGRESS_EVENTS } },
    },
  );
  return result.modifiedCount === 1;
}
