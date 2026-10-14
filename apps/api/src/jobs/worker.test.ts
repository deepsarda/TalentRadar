import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "./queue.js";
import { RetryLaterError } from "./rate-limit.js";
import { type JobHandler, startWorker } from "./worker.js";

type Fields = Partial<
  Record<
    "status" | "lockedUntil" | "runAt" | "followUpPending" | "attempts" | "followUpFailures",
    unknown
  >
>;
interface Update {
  $set?: Fields;
  $inc?: Fields;
  $unset?: Fields;
}

function claimedJob(): ClaimedJob {
  const now = new Date();
  return {
    _id: new ObjectId(),
    type: "aggregate_profile",
    payload: {},
    status: "running",
    attempts: 1,
    maxAttempts: 3,
    runAt: now,
    progress: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Just enough of the jobs collection for the worker: claims come from a script (a function per
 * call, so one can throw), updates are recorded, and renewals succeed unless `renewOk` is false.
 */
function fakeDb(options: {
  claims: Array<() => ClaimedJob | null>;
  renewOk?: boolean;
  pendingFollowUps?: ClaimedJob[];
}) {
  const updates: Update[] = [];
  let followUpFailures = 0;
  const jobs = {
    findOneAndUpdate: async (_filter: unknown, update: Update) => {
      if (update.$inc?.followUpFailures) return { followUpFailures: ++followUpFailures };
      return options.claims.shift()?.() ?? null;
    },
    updateOne: async (_filter: unknown, update: Update) => {
      updates.push(update);
      const isRenewal = update.$set?.lockedUntil !== undefined && !update.$set.status;
      return { modifiedCount: isRenewal && options.renewOk === false ? 0 : 1 };
    },
    find: () => {
      const cursor = {
        sort: () => cursor,
        limit: () => cursor,
        toArray: async () => options.pendingFollowUps?.splice(0) ?? [],
      };
      return cursor;
    },
  };
  return { db: { collection: () => jobs } as never, updates };
}

/** Starts a worker, waits until `done` resolves, then stops it. */
async function runUntil(
  db: never,
  handler: JobHandler,
  done: Promise<unknown>,
  options: Parameters<typeof startWorker>[2] = {},
) {
  const worker = startWorker(db, { aggregate_profile: handler }, { pollMs: 1, ...options });
  await done;
  await worker.stop();
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const statusOf = (update: Update) => update.$set?.status;

describe("worker loop", () => {
  it("survives a failed claim (e.g. a Mongo blip) and keeps working", async () => {
    const ran = deferred();
    const { db, updates } = fakeDb({
      claims: [
        () => {
          throw new Error("connection reset");
        },
        claimedJob,
      ],
    });
    await runUntil(
      db,
      async () => {
        ran.resolve();
        return { ok: true };
      },
      ran.promise.then(() => new Promise((resolve) => setTimeout(resolve, 20))),
    );
    expect(updates.some((update) => statusOf(update) === "done")).toBe(true);
  });

  it("stops treating a job as owned when its lease renewal is refused", async () => {
    const finished = deferred();
    let abortReason: unknown;
    const { db, updates } = fakeDb({ claims: [claimedJob], renewOk: false });
    await runUntil(
      db,
      async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        abortReason = signal.reason;
        finished.resolve();
        return { written: true }; // a handler that ignores the signal still must not complete
      },
      finished.promise.then(() => new Promise((resolve) => setTimeout(resolve, 20))),
      { leaseMs: 3_000 },
    );
    expect((abortReason as Error).message).toBe("Job lease was lost");
    expect(updates.some((update) => statusOf(update) === "done")).toBe(false);
    expect(updates.some((update) => statusOf(update) === "queued")).toBe(false);
  });

  it("reschedules a rate-limited job without using up an attempt", async () => {
    const thrown = deferred();
    const retryAt = new Date(Date.now() + 30 * 60_000);
    const { db, updates } = fakeDb({ claims: [claimedJob] });
    await runUntil(
      db,
      async () => {
        thrown.resolve();
        throw new RetryLaterError("GitHub rate limited", retryAt);
      },
      thrown.promise.then(() => new Promise((resolve) => setTimeout(resolve, 20))),
    );
    const deferral = updates.find((update) => statusOf(update) === "queued");
    expect(deferral?.$set?.runAt).toEqual(retryAt);
    expect(deferral?.$inc?.attempts).toBe(-1);
  });

  it("keeps the follow-up pending when queueing the next stage fails, and the sweep retries it", async () => {
    const failedOnce = deferred();
    const { db, updates } = fakeDb({ claims: [claimedJob] });
    await runUntil(db, async () => ({ assessmentId: "x" }), failedOnce.promise, {
      onCompleted: async () => {
        failedOnce.resolve();
        throw new Error("connection reset");
      },
    });
    const done = updates.find((update) => statusOf(update) === "done");
    expect(done?.$set?.followUpPending).toBe(true);
    expect(updates.some((update) => update.$unset?.followUpPending !== undefined)).toBe(false);

    const swept = deferred();
    const stranded = { ...claimedJob(), status: "done" as const, followUpPending: true };
    const recovery = fakeDb({ claims: [], pendingFollowUps: [stranded] });
    let sweptJob: ClaimedJob | undefined;
    await runUntil(
      recovery.db,
      async () => ({}),
      swept.promise.then(() => new Promise((resolve) => setTimeout(resolve, 20))),
      {
        onCompleted: async (job) => {
          sweptJob = job;
          swept.resolve();
        },
      },
    );
    expect(sweptJob?._id).toEqual(stranded._id);
    expect(recovery.updates.some((update) => update.$unset?.followUpPending !== undefined)).toBe(
      true,
    );
  });
});
