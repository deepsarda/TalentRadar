import { MongoServerError, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { enqueueJob, retryDelayMs } from "./queue.js";

describe("job retry delay", () => {
  it("backs off exponentially with bounded jitter", () => {
    expect(retryDelayMs(1, () => 0)).toBe(45_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(120_000);
    expect(retryDelayMs(3, () => 1)).toBe(300_000);
  });

  it("caps the base delay at one hour", () => {
    expect(retryDelayMs(20, () => 0.5)).toBe(3_600_000);
  });
});

describe("enqueueJob dedupe", () => {
  it("returns the existing job when the dedupe key is already taken", async () => {
    const existingId = new ObjectId();
    const jobs = {
      insertOne: async () => {
        throw new MongoServerError({ message: "E11000 duplicate key", code: 11000 });
      },
      findOne: async (filter: { dedupeKey?: string }) =>
        filter.dedupeKey === "p1:judge_person" ? { _id: existingId } : null,
    };
    const db = { collection: () => jobs } as never;
    const id = await enqueueJob(db, "judge_person", {}, { dedupeKey: "p1:judge_person" });
    expect(id).toEqual(existingId);
    await expect(enqueueJob(db, "judge_person", {})).rejects.toThrow("duplicate key");
  });
});
