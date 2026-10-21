import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "../jobs/queue.js";
import type { JobContext } from "../jobs/worker.js";
import { createPrewarmProfilesHandler } from "./prewarm.js";

type Doc = Record<string, unknown>;

function fakeDb(data: Record<string, Doc[]>) {
  const matches = (doc: Doc, filter: Doc) =>
    Object.entries(filter).every(([key, expected]) => {
      if (key === "$in") return true;
      const actual = doc[key];
      if (expected && typeof expected === "object" && "$ne" in expected) {
        return actual !== (expected as { $ne: unknown }).$ne;
      }
      if (expected && typeof expected === "object" && "$in" in expected) {
        const list = (expected as { $in: unknown[] }).$in;
        return list.some((item) => String(item) === String(actual));
      }
      if (actual instanceof ObjectId || expected instanceof ObjectId) {
        return String(actual) === String(expected);
      }
      return actual === expected;
    });

  const db = {
    collection: (name: string) => ({
      find: (filter: Doc = {}) => ({
        toArray: async () => (data[name] ?? []).filter((doc) => matches(doc, filter)),
      }),
      findOne: async (filter: Doc) =>
        (data[name] ?? []).find((doc) => matches(doc, filter)) ?? null,
      insertOne: async (doc: Doc) => {
        const _id = new ObjectId();
        data[name] ??= [];
        const saved = { ...doc, _id };
        data[name]?.push(saved);
        return { insertedId: _id };
      },
    }),
  };
  return { db: db as never, data };
}

function context(payload: Doc) {
  const progressLogs: Array<{ code: string; message: string }> = [];
  const progress = vi.fn(async (code: string, message: string) => {
    progressLogs.push({ code, message });
  });
  const job = { _id: new ObjectId(), payload, attempts: 1 } as ClaimedJob;
  return {
    progress,
    progressLogs,
    context: { job, progress, signal: new AbortController().signal } as unknown as JobContext,
  };
}

describe("prewarm handler", () => {
  it("handles event with no registrations", async () => {
    const hackathonId = new ObjectId();
    const { db } = fakeDb({ registrations: [] });
    const { context: ctx, progressLogs } = context({ hackathonId: hackathonId.toHexString() });

    const handler = createPrewarmProfilesHandler(db);
    const result = await handler(ctx);

    expect(result).toEqual({ total: 0, queued: 0 });
    expect(progressLogs.some((p) => p.code === "done")).toBe(true);
  });

  it("skips participants who already have ready or pending profiles", async () => {
    const hackathonId = new ObjectId();
    const p1 = new ObjectId();
    const p2 = new ObjectId();

    const registrations = [
      { hackathonId, personId: p1, selectedRepositories: ["owner/repo1"], status: "submitted" },
      { hackathonId, personId: p2, selectedRepositories: ["owner/repo2"], status: "submitted" },
    ];
    const profiles = [{ personId: p1, status: "ready" }];
    const people = [
      { _id: p1, name: "Person 1" },
      { _id: p2, name: "Person 2" },
    ];

    const { db, data } = fakeDb({
      registrations,
      profiles,
      people,
      jobs: [],
    });

    const { context: ctx, progressLogs } = context({ hackathonId: hackathonId.toHexString() });
    const handler = createPrewarmProfilesHandler(db);
    const result = await handler(ctx);

    expect(result.total).toBe(1);
    expect(result.queued).toBe(1);
    expect(progressLogs.some((p) => p.code === "completed")).toBe(true);

    // Profile for p2 was created
    const newProfiles = data["profiles"]?.filter((p) => String(p["personId"]) === p2.toHexString());
    expect(newProfiles).toHaveLength(1);
    expect(newProfiles?.[0]?.["status"]).toBe("pending");

    // Fetch repo job was queued for p2
    const fetchJobs = data["jobs"]?.filter((j) => j["type"] === "fetch_repo");
    expect(fetchJobs).toHaveLength(1);
    expect((fetchJobs?.[0]?.["payload"] as Doc | undefined)?.["repository"]).toBe("owner/repo2");
  });
});
