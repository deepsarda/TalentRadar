import { taxonomy } from "./taxonomy.js";

/*
 * The one home for every version identifier written to or compared against stored documents.
 * Each is part of the assessment cache key, so bumping one deliberately invalidates cached
 * judgments. versions.test.ts (shared) and judge.test.ts (api) pin a fingerprint of the content
 * each version names, so changing the content without bumping the version fails a test.
 */

/** Read from taxonomy.json so the file and the code can never disagree. */
export const taxonomyVersion = taxonomy.version;

/** Bump when proficiencyRubric or originalityRubric text in rubrics.ts changes. */
export const rubricVersion = "v1";

/** Bump when the judge prompt (judge.ts instructions or few-shot.ts examples) changes. */
<<<<<<< HEAD
export const promptVersion = "v4";
=======
export const promptVersion = "v7";
>>>>>>> 3d70cf8c20c58d0dbe0498b69827d1d6ec730e62

/**
 * Bump when stage-2 extraction changes what the judge is sent: file sampling in
 * apps/api/src/profile-pipeline/repository.ts, or technology detection in detect.ts.
<<<<<<< HEAD
 * v2: manifests in subfolders (monorepos) are detected.
 * v4: commit-activity consistency and merged upstream pull requests are collected and sent.
=======
 * v4: up to 20 files, prioritized by nonblank lines with technology-coverage slots,
 * supporting configuration and distributed excerpts of larger files.
>>>>>>> 3d70cf8c20c58d0dbe0498b69827d1d6ec730e62
 */
export const samplerVersion = "v4";
