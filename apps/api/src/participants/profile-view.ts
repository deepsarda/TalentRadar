import { ProfileJudgmentSchema } from "@talentradar/shared";
import type { Db } from "mongodb";
import type { AssessmentDocument, ProfileDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";

/** Read-only profile details shared by the participant and authorized event organizers. */
export async function serializeProfile(db: Db, profile: ProfileDocument) {
  const assessment = profile.assessmentId
    ? await db
        .collection<AssessmentDocument>(collections.assessments)
        .findOne({ _id: profile.assessmentId }, { projection: { result: 1 } })
    : null;
  const judgment = ProfileJudgmentSchema.safeParse(assessment?.result);
  return {
    id: profile._id.toHexString(),
    version: profile.version,
    status: profile.status,
    displayName: profile.displayName,
    repos: profile.repos,
    skills: profile.skills,
    novelty: profile.novelty,
    flags: profile.flags,
    summary: profile.summary,
    taxonomyVersion: profile.taxonomyVersion,
    builtAt: profile.builtAt?.toISOString(),
    error: profile.error,
    ...(judgment.success
      ? {
          assessment: {
            thoughts: judgment.data.thoughts,
            repositories: judgment.data.repos.map((repository) => ({
              repository: repository.repo,
              commitSha: repository.commitSha,
              originality: repository.originality,
              authorship: repository.authorship,
              qualifiesForNovelty:
                repository.originality >= 4 && repository.skills.some((skill) => skill.level >= 3),
            })),
          },
        }
      : {}),
  };
}
