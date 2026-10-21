import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { JobType } from "../database/models.js";
import {
  appendJobProgress,
  backoffMs,
  type ClaimedJob,
  claimJob,
  clearFollowUp,
  completeJob,
  deferJob,
  failJob,
  findPendingFollowUps,
  recordFollowUpFailure,
  renewJobLease,
} from "./queue.js";
import { RetryLaterError } from "./rate-limit.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;
const MAX_LOOP_BACKOFF_MS = 60_000;
const FOLLOW_UP_SWEEP_MS = 60_000;
const MAX_FOLLOW_UP_FAILURES = 5;

export interface JobContext {
  job: ClaimedJob;
  progress(code: string, message: string): Promise<void>;
  /** Aborts on shutdown or when the lease is lost; check it before writing results. */
  signal: AbortSignal;
}

export type JobHandler = (context: JobContext) => Promise<unknown>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface WorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  /** Runs after a job is done (e.g. enqueue its next stage). Must be idempotent: it is retried. */
  onCompleted?: (job: ClaimedJob, result?: Record<string, unknown>) => Promise<void>;
  onTerminalFailure?: (job: ClaimedJob, error: string) => Promise<void>;
}

export interface WorkerController {
  stop(): Promise<void>;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown worker failure";
}

export function startWorker(
  db: Db,
  handlers: JobHandlers,
  options: WorkerOptions = {},
): WorkerController {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const types = Object.keys(handlers) as JobType[];
  const controller = new AbortController();
  const { onCompleted, onTerminalFailure } = options;

  async function runFollowUp(job: ClaimedJob, result?: Record<string, unknown>): Promise<void> {
    if (!onCompleted) return;
    try {
      await onCompleted(job, result);
    } catch (error) {
      console.error(`Follow-up for job ${job._id.toHexString()} failed`, error);
      const failures = await recordFollowUpFailure(db, job._id);
      if (failures < MAX_FOLLOW_UP_FAILURES) return;
      await onTerminalFailure?.(job, `Next stage could not be queued: ${errorMessage(error)}`);
    }
    await clearFollowUp(db, job._id);
  }

  /** Re-runs follow-ups that a crash or a database blip interrupted after a job completed. */
  async function sweepFollowUps(): Promise<void> {
    const stale = await findPendingFollowUps(db, new Date(Date.now() - 2 * leaseMs), 20);
    for (const job of stale) await runFollowUp(job, job.result);
  }

  async function runJob(job: ClaimedJob, handler: JobHandler): Promise<void> {
    const lease = new AbortController();
    const renewEveryMs = Math.max(1_000, Math.floor(leaseMs / 3));
    let leaseUntil = Date.now() + leaseMs;
    const heartbeat = setInterval(() => {
      renewJobLease(db, job._id, workerId, leaseMs).then(
        (renewed) => {
          if (renewed) leaseUntil = Date.now() + leaseMs;
          else lease.abort(new Error("Job lease was lost"));
        },
        (error: unknown) => {
          // A transient failure is fine while the lease is still ours; once it may have
          // expired another worker can claim the job, so stop treating it as owned.
          console.warn(`Lease renewal for job ${job._id.toHexString()} failed`, error);
          if (Date.now() + renewEveryMs >= leaseUntil) {
            lease.abort(new Error("Job lease could not be renewed"));
          }
        },
      );
    }, renewEveryMs);

    try {
      let result: unknown;
      try {
        result = await handler({
          job,
          signal: AbortSignal.any([controller.signal, lease.signal]),
          progress: async (code, message) => {
            const saved = await appendJobProgress(db, job._id, workerId, code, message);
            if (!saved) throw new Error("Job lease was lost while writing progress");
          },
        });
      } catch (error) {
        if (lease.signal.aborted) return; // Another worker may own it now; write nothing.
        if (controller.signal.aborted) {
          await deferJob(db, job, workerId, "Worker stopped; job released", new Date());
          return;
        }
        if (error instanceof RetryLaterError && !error.countsAsAttempt) {
          await deferJob(db, job, workerId, error.message, error.retryAt);
          return;
        }
        const message = errorMessage(error);
        console.error(`Job ${job.type} (${job._id.toHexString()}) failed:`, message, error);
        const delayMs =
          error instanceof RetryLaterError
            ? Math.max(0, error.retryAt.getTime() - Date.now())
            : undefined;
        const failed = await failJob(db, job, workerId, message, delayMs);
        if (failed && job.attempts >= job.maxAttempts) await onTerminalFailure?.(job, message);
        return;
      }
      if (lease.signal.aborted) return;
      const savedResult =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : undefined;
      const completed = await completeJob(db, job._id, workerId, savedResult, {
        followUp: Boolean(onCompleted),
      });
      if (completed) await runFollowUp(job, savedResult);
    } finally {
      clearInterval(heartbeat);
    }
  }

  const run = (async () => {
    let consecutiveFailures = 0;
    let nextSweepAt = 0;
    while (!controller.signal.aborted) {
      try {
        if (onCompleted && Date.now() >= nextSweepAt) {
          nextSweepAt = Date.now() + FOLLOW_UP_SWEEP_MS;
          await sweepFollowUps();
        }
        const job = await claimJob(db, workerId, types, leaseMs);
        const handler = job ? handlers[job.type] : undefined;
        if (job && handler) await runJob(job, handler);
        consecutiveFailures = 0;
        if (!job) await delay(pollMs, controller.signal);
      } catch (error) {
        // A database blip must not kill the loop: log, back off, try again.
        consecutiveFailures += 1;
        console.error("Worker loop failed; backing off", error);
        await delay(
          backoffMs(consecutiveFailures, { baseMs: pollMs, capMs: MAX_LOOP_BACKOFF_MS }),
          controller.signal,
        );
      }
    }
  })();

  return {
    async stop() {
      controller.abort();
      await run;
    },
  };
}
