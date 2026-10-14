import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { JobType } from "../database/models.js";
import {
  appendJobProgress,
  type ClaimedJob,
  claimJob,
  completeJob,
  failJob,
  renewJobLease,
} from "./queue.js";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;

export interface JobContext {
  job: ClaimedJob;
  progress(code: string, message: string): Promise<void>;
  signal: AbortSignal;
}

export type JobHandler = (context: JobContext) => Promise<unknown>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface WorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
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

  const run = (async () => {
    while (!controller.signal.aborted) {
      const job = await claimJob(db, workerId, types, leaseMs);
      if (!job) {
        await delay(pollMs, controller.signal);
        continue;
      }

      const handler = handlers[job.type];
      if (!handler) continue;
      const heartbeat = setInterval(
        () => {
          void renewJobLease(db, job._id, workerId, leaseMs);
        },
        Math.max(1_000, Math.floor(leaseMs / 3)),
      );

      try {
        const result = await handler({
          job,
          signal: controller.signal,
          progress: async (code, message) => {
            const saved = await appendJobProgress(db, job._id, workerId, code, message);
            if (!saved) throw new Error("Job lease was lost while writing progress");
          },
        });
        const savedResult =
          result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : undefined;
        const completed = await completeJob(db, job._id, workerId, savedResult);
        if (completed) await options.onCompleted?.(job, savedResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown worker failure";
        const failed = await failJob(db, job, workerId, message);
        if (failed && job.attempts >= job.maxAttempts) {
          await options.onTerminalFailure?.(job, message);
        }
      } finally {
        clearInterval(heartbeat);
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
