import type { ProfileJudgment } from "@talentradar/shared";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { Environment } from "../config/environment.js";
import type { ClaimedJob } from "../jobs/queue.js";
import type { JobContext } from "../jobs/worker.js";
import { createAggregateProfileHandler } from "./aggregate.js";
import {
  assessmentCacheKey,
  secondOpinionCacheKey,
  secondOpinionModel,
  secondOpinionPromptVersion,
} from "./cache-key.js";
import { createProfileOrchestrator } from "./orchestrator.js";
import { createSecondOpinionHandler } from "./second-opinion.js";

type Doc = Record<string, unknown>;

/** Just the Db operations these stages use, over plain arrays keyed by collection name. */
function fakeDb(data: Record<string, Doc[]>) {
  const matches = (doc: Doc, filter: Doc) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key];
      if (actual instanceof ObjectId || expected instanceof ObjectId) {
        return String(actual) === String(expected);
      }
      return actual === expected;
    });
  const updates: Array<{ collection: string; filter: Doc; update: Doc }> = [];
  const db = {
    collection: (name: string) => ({
      findOne: async (filter: Doc) =>
        (data[name] ?? []).find((doc) => matches(doc, filter)) ?? null,
      insertOne: async (doc: Doc) => {
        const _id = new ObjectId();
        data[name] ??= [];
        data[name]?.push({ ...doc, _id });
        return { insertedId: _id };
      },
      updateOne: async (filter: Doc, update: Doc) => {
        updates.push({ collection: name, filter, update });
        return { modifiedCount: 1 };
      },
    }),
  };
  return { db: db as never, updates };
}

function onlyUpdate(updates: Array<{ filter: Doc; update: Doc }>) {
  const first = updates[0];
  if (!first) throw new Error("expected one update");
  return first as { filter: Doc; update: { $set: Doc; $unset: Doc } };
}

const environment = {
  GEMINI_API_KEY: "test-key",
  GEMINI_MODEL: "model-a",
} as Environment;

function context(payload: Doc, extra: Partial<ClaimedJob> = {}) {
  const progress = vi.fn(async () => {});
  const job = { _id: new ObjectId(), payload, attempts: 1, ...extra } as ClaimedJob;
  return {
    progress,
    context: { job, progress, signal: new AbortController().signal } as unknown as JobContext,
  };
}

const ids = {
  profile: new ObjectId(),
  person: new ObjectId(),
  primary: new ObjectId(),
  second: new ObjectId(),
};

function judgment(level: number, extra: Partial<ProfileJudgment> = {}): ProfileJudgment {
  return {
    thoughts: "t",
    summary: "summary",
    repos: [
      {
        repo: "riya/app",
        commitSha: "a".repeat(40),
        pushedAt: "2026-09-01T00:00:00Z",
        authorship: 1,
        originality: 4,
        skills: [
          {
            id: "backend",
            level,
            evidence: [{ path: "src/a.ts", note: `level ${level}` }],
            thought: "x",
          },
        ],
      },
    ],
    cv: { claims: [] },
    flags: [],
    ...extra,
  };
}

describe("second-opinion cache key", () => {
  const primaryKey = assessmentCacheKey([{ repo: "riya/app", sha: "abc" }], "cv", environment);

  it("is stable and differs from the primary key", () => {
    expect(secondOpinionCacheKey(primaryKey, environment)).toBe(
      secondOpinionCacheKey(primaryKey, environment),
    );
    expect(secondOpinionCacheKey(primaryKey, environment)).not.toBe(primaryKey);
  });

  it("changes with the primary assessment and with the second model", () => {
    const base = secondOpinionCacheKey(primaryKey, environment);
    expect(secondOpinionCacheKey(`${primaryKey}x`, environment)).not.toBe(base);
    expect(
      secondOpinionCacheKey(primaryKey, { ...environment, GEMINI_SECOND_OPINION_MODEL: "model-b" }),
    ).not.toBe(base);
  });

  it("uses the primary model unless a second one is configured", () => {
    expect(secondOpinionModel(environment)).toBe("model-a");
    expect(secondOpinionModel({ ...environment, GEMINI_SECOND_OPINION_MODEL: "model-b" })).toBe(
      "model-b",
    );
  });

  it("names itself as a second opinion", () => {
    expect(secondOpinionPromptVersion).toContain("+second");
  });
});

describe("second-opinion handler", () => {
  const payload = {
    profileId: ids.profile.toHexString(),
    personId: ids.person.toHexString(),
    assessmentId: ids.primary.toHexString(),
  };

  it("needs an API key", () => {
    expect(() =>
      createSecondOpinionHandler({} as never, { GEMINI_MODEL: "m" } as Environment),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it("skips without spending quota when the profile was rebuilt since the request", async () => {
    const { db } = fakeDb({
      profiles: [{ _id: ids.profile, assessmentId: new ObjectId() }],
    });
    const { context: ctx, progress } = context(payload);
    const result = await createSecondOpinionHandler(db, environment)(ctx);
    expect(result).toEqual({ skipped: "stale_profile" });
    expect(progress).toHaveBeenCalledWith("second_opinion.skipped", expect.any(String));
  });

  it("reuses a stored second opinion for identical inputs", async () => {
    const cacheKey = "primary-key";
    const { db } = fakeDb({
      profiles: [{ _id: ids.profile, assessmentId: ids.primary }],
      assessments: [
        { _id: ids.primary, cacheKey },
        { _id: ids.second, cacheKey: secondOpinionCacheKey(cacheKey, environment) },
      ],
    });
    const { context: ctx } = context(payload);
    const result = await createSecondOpinionHandler(db, environment)(ctx);
    expect(result).toEqual({
      assessmentId: payload.assessmentId,
      secondAssessmentId: ids.second.toHexString(),
      cached: true,
    });
  });
});

describe("orchestrator after a second opinion", () => {
  const job = (result?: Doc) =>
    ({
      type: "judge_second_opinion",
      payload: { profileId: ids.profile.toHexString(), personId: ids.person.toHexString() },
      result,
    }) as unknown as ClaimedJob;

  it("re-aggregates once per second assessment, merging both", async () => {
    const data: Record<string, Doc[]> = {};
    const { db } = fakeDb(data);
    const result = {
      assessmentId: ids.primary.toHexString(),
      secondAssessmentId: ids.second.toHexString(),
    };
    await createProfileOrchestrator(db).completed(job(result), result);
    expect(data["jobs"]).toHaveLength(1);
    expect(data["jobs"]?.[0]).toMatchObject({
      type: "aggregate_profile",
      payload: {
        profileId: ids.profile.toHexString(),
        assessmentId: ids.primary.toHexString(),
        secondAssessmentId: ids.second.toHexString(),
      },
      dedupeKey: `${ids.profile.toHexString()}:aggregate_profile:${ids.second.toHexString()}`,
    });
  });

  it("does nothing for a skipped second opinion and fails loudly on a malformed result", async () => {
    const data: Record<string, Doc[]> = {};
    const { db } = fakeDb(data);
    const orchestrator = createProfileOrchestrator(db);
    await orchestrator.completed(job({ skipped: "stale_profile" }), { skipped: "stale_profile" });
    expect(data["jobs"]).toBeUndefined();
    await expect(orchestrator.completed(job({}), {})).rejects.toThrow(/assessment ids/);
  });
});

describe("aggregate with a second opinion", () => {
  function setup() {
    const profile = {
      _id: ids.profile,
      displayName: "Riya",
      assessmentId: ids.primary,
    };
    const data = {
      profiles: [profile],
      assessments: [
        { _id: ids.primary, result: judgment(5), facts: [] },
        { _id: ids.second, result: judgment(3), facts: [] },
      ],
    };
    return fakeDb(data as never);
  }

  const base = {
    profileId: ids.profile.toHexString(),
    personId: ids.person.toHexString(),
    assessmentId: ids.primary.toHexString(),
  };

  it("builds skills from the merged judgment and records the disagreement", async () => {
    const { db, updates } = setup();
    const { context: ctx } = context({ ...base, secondAssessmentId: ids.second.toHexString() });
    await createAggregateProfileHandler(db)(ctx);

    const { filter, update } = onlyUpdate(updates);
    const set = update.$set;
    const skills = set["skills"] as Array<{ id: string; level: number }>;
    expect(skills.find((skill) => skill.id === "backend")?.level).toBe(3);
    expect(String(set["secondAssessmentId"])).toBe(ids.second.toHexString());
    expect(set["judgeDisagreement"]).toMatchObject({ maxLevelGap: 2, comparedSkills: 1 });
    expect(filter).toMatchObject({ assessmentId: ids.primary });
    expect(update.$unset).not.toHaveProperty("secondAssessmentId");
  });

  it("keeps the primary-only result and clears second-opinion fields without one", async () => {
    const { db, updates } = setup();
    const { context: ctx } = context(base);
    await createAggregateProfileHandler(db)(ctx);

    const { $set, $unset } = onlyUpdate(updates).update;
    const skills = $set["skills"] as Array<{ id: string; level: number }>;
    expect(skills.find((skill) => skill.id === "backend")?.level).toBe(5);
    expect($set).not.toHaveProperty("secondAssessmentId");
    expect($unset).toHaveProperty("secondAssessmentId");
    expect($unset).toHaveProperty("judgeDisagreement");
  });

  it("fails when the second assessment is missing", async () => {
    const { db } = setup();
    const { context: ctx } = context({ ...base, secondAssessmentId: new ObjectId().toHexString() });
    await expect(createAggregateProfileHandler(db)(ctx)).rejects.toThrow(/Second-opinion/);
  });
});
