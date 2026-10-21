import { GoogleGenAI } from "@google/genai";
import { rubricVersion, samplerVersion, taxonomyVersion } from "@talentradar/shared";
import type { Db } from "mongodb";
import { MongoServerError, ObjectId } from "mongodb";
import { z } from "zod";
import type { Environment } from "../config/environment.js";
import type { AssessmentDocument, JobDocument, ProfileDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { JobContext } from "../jobs/worker.js";
import {
  secondOpinionCacheKey,
  secondOpinionModel,
  secondOpinionPromptVersion,
} from "./cache-key.js";
import { renderCvPages } from "./cv.js";
import { judgeProfile, loadJudgeInputs } from "./judge.js";

export const SecondOpinionPayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  /** The primary assessment this opinion is for. A rebuilt profile has a new one, and is skipped. */
  assessmentId: z.string().length(24),
});

/**
 * The second judge for a borderline candidate. It reuses the facts the primary judge saw (no
 * refetching), reads the repositories in reverse order to cancel position bias, and may run on a
 * different model (GEMINI_SECOND_OPINION_MODEL). Its assessment is stored next to the primary one
 * and merged into the profile by the aggregate stage; it never replaces the primary assessment.
 * All Gemini traffic goes through the same limiter as the primary judge.
 */
export function createSecondOpinionHandler(db: Db, environment: Environment) {
  const apiKey = environment.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Second-opinion worker requires GEMINI_API_KEY");
  const ai = new GoogleGenAI({ apiKey });
  return async ({ job, progress, signal }: JobContext): Promise<Record<string, unknown>> => {
    const payload = SecondOpinionPayloadSchema.parse(job.payload);
    const profile = await db
      .collection<ProfileDocument>(collections.profiles)
      .findOne({ _id: ObjectId.createFromHexString(payload.profileId) });
    if (!profile?.assessmentId || profile.assessmentId.toHexString() !== payload.assessmentId) {
      await progress(
        "second_opinion.skipped",
        "The profile was rebuilt since this was requested; no quota spent",
      );
      return { skipped: "stale_profile" };
    }
    const primary = await db
      .collection<AssessmentDocument>(collections.assessments)
      .findOne({ _id: profile.assessmentId });
    if (!primary) throw new Error("Primary assessment is missing");

    const key = secondOpinionCacheKey(primary.cacheKey, environment);
    const assessments = db.collection<AssessmentDocument>(collections.assessments);
    const cached = await assessments.findOne({ cacheKey: key });
    if (cached) {
      await progress("second_opinion.cache_hit", "Reused the stored second opinion");
      return {
        assessmentId: payload.assessmentId,
        secondAssessmentId: cached._id.toHexString(),
        cached: true,
      };
    }

    const renderJob = await db
      .collection<JobDocument>(collections.jobs)
      .findOne({ "payload.profileId": payload.profileId, type: "render_cv", status: "done" });
    const fileIdValue = renderJob?.payload["fileId"];
    const fileId = typeof fileIdValue === "string" ? fileIdValue : undefined;
    const { repositories, cv } = await loadJudgeInputs(db, payload.profileId, fileId);

    const model = secondOpinionModel(environment);
    await progress("second_opinion.model.started", `Second opinion with ${model}`);
    const pages = fileId
      ? await renderCvPages(db, ObjectId.createFromHexString(fileId), signal)
      : [];
    const { result } = await judgeProfile({
      ai,
      model,
      repositories: [...repositories].reverse(),
      cv,
      pages,
      attempt: job.attempts,
      signal,
    });
    signal.throwIfAborted();

    const assessment: Omit<AssessmentDocument, "_id"> = {
      cacheKey: key,
      personId: ObjectId.createFromHexString(payload.personId),
      facts: repositories,
      cvLinks: cv.links,
      result,
      model,
      promptVersion: secondOpinionPromptVersion,
      taxonomyVersion,
      rubricVersion,
      samplerVersion,
      kind: "second_opinion",
      basedOnAssessmentId: primary._id,
      createdAt: new Date(),
    };
    let secondAssessmentId: ObjectId;
    try {
      secondAssessmentId = (await assessments.insertOne(assessment as AssessmentDocument))
        .insertedId;
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
      const raced = await assessments.findOne({ cacheKey: key });
      if (!raced) throw error;
      secondAssessmentId = raced._id;
    }
    await progress(
      "second_opinion.model.completed",
      `Validated ${result.repos.length} repository assessment blocks`,
    );
    return {
      assessmentId: payload.assessmentId,
      secondAssessmentId: secondAssessmentId.toHexString(),
      cached: false,
    };
  };
}
