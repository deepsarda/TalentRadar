import {
  aggregateProfile,
  judgmentDisagreement,
  mergeJudgments,
  ProfileJudgmentSchema,
  withDetectedTools,
} from "@talentradar/shared";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AssessmentDocument, ProfileDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { JobContext } from "../jobs/worker.js";
import { detectedTools, FetchResultSchema, mergedUpstreamPullRequests } from "./judge.js";

const AggregatePayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  assessmentId: z.string().length(24),
  /** When present, the second judge's assessment is merged with the primary one. */
  secondAssessmentId: z.string().length(24).optional(),
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
    const primaryJudgment = ProfileJudgmentSchema.parse(assessment.result);
    let judgment = primaryJudgment;
    let disagreement: ReturnType<typeof judgmentDisagreement> | undefined;
    if (payload.secondAssessmentId) {
      const second = await db
        .collection<AssessmentDocument>(collections.assessments)
        .findOne({ _id: ObjectId.createFromHexString(payload.secondAssessmentId) });
      if (!second) throw new Error("Second-opinion assessment is missing");
      const secondJudgment = ProfileJudgmentSchema.parse(second.result);
      disagreement = judgmentDisagreement([primaryJudgment, secondJudgment]);
      judgment = mergeJudgments([primaryJudgment, secondJudgment]);
    }
    // Tools the detectors found but the model didn't judge stay in, marked unanalysed.
    const facts = z.array(FetchResultSchema).safeParse(assessment.facts);
    const merged = facts.success ? mergedUpstreamPullRequests(facts.data) : undefined;
    const aggregated = withDetectedTools(
      aggregateProfile(
        payload.personId,
        profile.displayName,
        judgment,
        new Date(),
        merged === undefined ? {} : { signals: { mergedUpstreamPullRequests: merged } },
      ),
      facts.success ? detectedTools(facts.data) : [],
    );
    const now = new Date();
    await db.collection<ProfileDocument>(collections.profiles).updateOne(
      { _id: profileId, assessmentId: assessment._id },
      {
        $set: {
          status: "ready",
          // The repository list always comes from the primary judgment: a second judge that skipped
          // one must not make a repository disappear from the profile.
          repos: primaryJudgment.repos.map((repository) => ({
            fullName: repository.repo,
            sha: repository.commitSha,
            included: true,
          })),
          skills: aggregated.skills,
          novelty: aggregated.novelty,
          flags: aggregated.flags,
          ...(aggregated.summary ? { summary: aggregated.summary } : {}),
          ...(payload.secondAssessmentId && disagreement
            ? {
                secondAssessmentId: ObjectId.createFromHexString(payload.secondAssessmentId),
                judgeDisagreement: disagreement,
              }
            : {}),
          builtAt: now,
          updatedAt: now,
        },
        $unset: {
          error: "",
          // A plain re-aggregation must not keep a second opinion that belonged to older skills.
          ...(payload.secondAssessmentId ? {} : { secondAssessmentId: "", judgeDisagreement: "" }),
        },
      },
    );
    await progress(
      "profile.aggregate.completed",
      `Built ${aggregated.skills.length} evidence-backed skill profiles`,
    );
    return { profileId: payload.profileId, skills: aggregated.skills.length };
  };
}
