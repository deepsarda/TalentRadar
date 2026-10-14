import { aggregateProfile, ProfileJudgmentSchema, withDetectedTools } from "@talentradar/shared";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AssessmentDocument, ProfileDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { JobContext } from "../jobs/worker.js";
import { detectedTools, FetchResultSchema } from "./judge.js";

const AggregatePayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  assessmentId: z.string().length(24),
});

export function createAggregateProfileHandler(db: Db) {
  return async ({ job, progress }: JobContext): Promise<Record<string, unknown>> => {
    const payload = AggregatePayloadSchema.parse(job.payload);
    const profileId = ObjectId.createFromHexString(payload.profileId);
    const [profile, assessment] = await Promise.all([
      db.collection<ProfileDocument>(collections.profiles).findOne({ _id: profileId }),
      db
        .collection<AssessmentDocument>(collections.assessments)
        .findOne({ _id: ObjectId.createFromHexString(payload.assessmentId) }),
    ]);
    if (!profile || !assessment) throw new Error("Profile aggregation inputs are missing");
    const judgment = ProfileJudgmentSchema.parse(assessment.result);
    // Tools the detectors found but the model didn't judge stay in, marked unanalysed.
    const facts = z.array(FetchResultSchema).safeParse(assessment.facts);
    const aggregated = withDetectedTools(
      aggregateProfile(payload.personId, profile.displayName, judgment),
      facts.success ? detectedTools(facts.data) : [],
    );
    const now = new Date();
    await db.collection<ProfileDocument>(collections.profiles).updateOne(
      { _id: profileId, assessmentId: assessment._id },
      {
        $set: {
          status: "ready",
          repos: judgment.repos.map((repository) => ({
            fullName: repository.repo,
            sha: repository.commitSha,
            included: true,
          })),
          skills: aggregated.skills,
          novelty: aggregated.novelty,
          flags: aggregated.flags,
          builtAt: now,
          updatedAt: now,
        },
        $unset: { error: "" },
      },
    );
    await progress(
      "profile.aggregate.completed",
      `Built ${aggregated.skills.length} evidence-backed skill profiles`,
    );
    return { profileId: payload.profileId, skills: aggregated.skills.length };
  };
}
