import { type Db, MongoServerError, type ObjectId } from "mongodb";
import type { JobDocument, JobProgressEvent, JobType } from "../database/models.js";
import { collections } from "../database/mongo.js";

const MAX_PROGRESS_EVENTS = 200;

export interface EnqueueJobOptions {
  maxAttempts?: number;
  runAt?: Date;
  /** One job per key, e.g. `${profileId}:judge_person`; enqueueing it again returns the original. */
  dedupeKey?: string;
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
    ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const jobs = db.collection<JobDocument>(collections.jobs);
  try {
    const result = await jobs.insertOne(job);
    return result.insertedId;
  } catch (error) {
    if (!(options.dedupeKey && error instanceof MongoServerError && error.code === 11000)) {
      throw error;
    }
    const existing = await jobs.findOne({ dedupeKey: options.dedupeKey });
    if (!existing) throw error;
    return existing._id;
  }
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

/**
 * Marks a job done. With `followUp`, the job also gets `followUpPending` until clearFollowUp():
 * if the process dies between completion and enqueueing the next stage, the worker's sweep
 * finds the flag and runs the follow-up again, so a profile is never stranded.
 */
export async function completeJob(
  db: Db,
  jobId: ObjectId,
  workerId: string,
  jobResult?: Record<string, unknown>,
  options: { followUp?: boolean } = {},
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
        ...(options.followUp ? { followUpPending: true } : {}),
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

/** Exponential backoff with ±25% jitter: baseMs, 2×, 4×… capped at capMs before jitter. */
export function backoffMs(
  attempt: number,
  { baseMs, capMs }: { baseMs: number; capMs: number },
  random = Math.random,
): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), capMs);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export function retryDelayMs(attempt: number, random = Math.random): number {
  return backoffMs(attempt, { baseMs: 60_000, capMs: 60 * 60 * 1000 }, random);
}

/**
 * Puts a running job back in the queue until `runAt` without using up an attempt: for rate-limit
 * waits and graceful shutdown. Ceiling: a job deferred forever never fails; rate limits reset,
 * so that only happens if GitHub/Gemini keep returning 429 indefinitely.
 */
export async function deferJob(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  reason: string,
  runAt: Date,
): Promise<boolean> {
  const now = new Date();
  const event: JobProgressEvent = { at: now, code: "job.deferred", message: reason.slice(0, 500) };
  const result = await db.collection<JobDocument>(collections.jobs).updateOne(
    { _id: job._id, status: "running", lockedBy: workerId },
    {
      $set: { status: "queued", runAt, updatedAt: now },
      $inc: { attempts: -1 },
      $unset: { lockedBy: "", lockedUntil: "" },
      $push: { progress: { $each: [event], $slice: -MAX_PROGRESS_EVENTS } },
    },
  );
  return result.modifiedCount === 1;
}

/** Done jobs whose follow-up did not finish, completed before `completedBefore`. */
export function findPendingFollowUps(
  db: Db,
  completedBefore: Date,
  limit: number,
): Promise<ClaimedJob[]> {
  return db
    .collection<JobDocument>(collections.jobs)
    .find({ followUpPending: true, completedAt: { $lte: completedBefore } })
    .sort({ completedAt: 1 })
    .limit(limit)
    .toArray();
}

export async function clearFollowUp(db: Db, jobId: ObjectId): Promise<void> {
  await db
    .collection<JobDocument>(collections.jobs)
    .updateOne({ _id: jobId }, { $unset: { followUpPending: "", followUpFailures: "" } });
}

/** Counts a failed follow-up and returns how many have failed so far. */
export async function recordFollowUpFailure(db: Db, jobId: ObjectId): Promise<number> {
  const job = await db
    .collection<JobDocument>(collections.jobs)
    .findOneAndUpdate(
      { _id: jobId },
      { $inc: { followUpFailures: 1 } },
      { returnDocument: "after" },
    );
  return job?.followUpFailures ?? 0;
}

/**
 * The error as one readable build-log line: the log is the only place a participant or organizer
 * sees why a build stalls. Credentials never belong in it, so token-shaped strings are masked.
 */
export function logReason(error: string): string {
  const line = error.replace(/\s+/g, " ").trim();
  const masked = line
    .replace(/gh[opsu]_[A-Za-z0-9]{20,}/g, "<github-token>")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "<api-key>")
    .replace(/Bearer\s+\S+/gi, "Bearer <token>")
    .replace(/mongodb(\+srv)?:\/\/\S+/g, "<database-url>");
  return masked.length > 240 ? `${masked.slice(0, 239)}…` : masked || "unknown error";
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
      ? `Failed after ${job.attempts} attempts: ${logReason(error)}`
      : `Retry ${job.attempts + 1}/${job.maxAttempts} in ${Math.ceil(delayMs / 1000)}s: ${logReason(error)}`,
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
