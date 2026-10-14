# Held-out calibration set

The answer to "how do you know the scores are right?" (spec: Risks). Ten public repos, scored by
two people independently, that the judge has never seen as examples. `pnpm run calibrate` profiles
each repo on its own and reports **within ±1 level on N of 10**. The target is at least 8 of 10,
and the engine gate (Days 2–4) is not passed until it is met. Re-run it after every prompt,
rubric, taxonomy or sampler change; the header line prints all four versions.

`calibration-set.json` ships with **zero entries** on purpose. The labels must come from people
reading code, never from a script or a model.

## How to fill it

1. **Pick 10 public repos** that are not your own team's and are not in `few-shot.ts`
   (the schema rejects those). The mix the spec asks for:
   - two **genuine 5s**: an original problem and an original design visible in the code;
   - two that **look novel but are not** (a striking README over a known pattern);
   - six ordinary repos spread across levels 1–4 and across different domains.
2. **Pin the commit.** Record the full 40-character SHA you scored. The runner warns when `HEAD`
   has moved on, because a changed repo makes the comparison meaningless.
3. **Two people score independently.** Each reads the code (not just the README) against the
   rubrics in `packages/shared/src/taxonomy/rubrics.ts`, without seeing the other's scores or any
   model output, and gives:
   - one **originality** score, 1–5;
   - a **level**, 1–5, for each skill they see evidence of, using taxonomy ids
     (`packages/shared/src/taxonomy/taxonomy.json`), e.g. `react`, `pytorch`, `backend`.
     Both people score the same skill list; agree on which skills to score before scoring.
4. **Add one entry per repo:**

   ```json
   {
     "repository": "owner/name",
     "commitSha": "<40-char sha both people scored>",
     "kind": "genuine_novel | looks_novel_but_not | ordinary",
     "originality": { "scorerA": 4, "scorerB": 5 },
     "skills": {
       "react": { "scorerA": 3, "scorerB": 3 },
       "express": { "scorerA": 2, "scorerB": 3 }
     },
     "notes": "optional: why this repo is in the set"
   }
   ```

5. **Check disagreements.** Where the two scores differ by more than one level the runner marks
   `[scorers disagree by >1]`. Talk it through and re-score; do not average away a real
   disagreement.

## How it is scored

For each repo, the human mean is `(scorerA + scorerB) / 2` per dimension. The model's repo-level
originality and its per-repo skill levels (before aggregation) are compared with it. A repo counts
as **within** only if originality and every human-scored skill are within ±1 of the mean; a skill
the model did not report counts as a miss. Skills the model reports that the humans did not score
are ignored. The math lives in `calibration.ts` and is tested in `calibration.test.ts`.

Running it needs `GITHUB_TOKEN` and `GEMINI_API_KEY` (one Gemini call per repo, 10 in total).
Use the development Google Cloud project, not the demo one.
