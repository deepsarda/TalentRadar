import { createHash } from "node:crypto";
import { promptVersion, rubricVersion, samplerVersion, taxonomyVersion } from "@talentradar/shared";
import type { Environment } from "../config/environment.js";

/**
 * The assessment cache key: a hash of every input the judge sees (included repos at their commit,
 * the CV file hash, model, prompt, taxonomy, rubric and sampler versions). Same inputs, same
 * stored answer. The judge writes it; the application flow computes it up front to reuse a ready
 * profile instead of rebuilding, so both must call this one function.
 */
export function assessmentCacheKey(
  repositories: ReadonlyArray<{ repo: string; sha: string }>,
  cvHash: string,
  environment: Pick<Environment, "GEMINI_MODEL">,
): string {
  const inputs = repositories
    .map(({ repo, sha }) => ({ repo, sha }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
  return createHash("sha256")
    .update(
      JSON.stringify({
        inputs,
        cvHash,
        model: environment.GEMINI_MODEL,
        prompt: promptVersion,
        taxonomy: taxonomyVersion,
        rubric: rubricVersion,
        sampler: samplerVersion,
      }),
    )
    .digest("hex");
}

/**
 * Marks a second-opinion assessment. The second judge reads the repositories in reverse order, so
 * the version names that: change either the order or the prompt and this must change with it.
 */
export const secondOpinionPromptVersion = `${promptVersion}+second.v1`;

/** The model that gives the second opinion; the primary model when none is configured. */
export function secondOpinionModel(
  environment: Pick<Environment, "GEMINI_MODEL" | "GEMINI_SECOND_OPINION_MODEL">,
): string {
  return environment.GEMINI_SECOND_OPINION_MODEL ?? environment.GEMINI_MODEL;
}

/**
 * Cache key of a second opinion: the primary assessment's key (which already covers repositories
 * at their commits, the CV hash and every version) plus the second model and prompt version.
 */
export function secondOpinionCacheKey(
  primaryCacheKey: string,
  environment: Pick<Environment, "GEMINI_MODEL" | "GEMINI_SECOND_OPINION_MODEL">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        primary: primaryCacheKey,
        model: secondOpinionModel(environment),
        prompt: secondOpinionPromptVersion,
      }),
    )
    .digest("hex");
}
