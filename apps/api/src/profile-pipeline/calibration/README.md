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

## Checking the set, and the CI gate

Three commands, in the order you will use them:

```sh
pnpm calibration:validate            # offline: is the set well formed? how well do the scorers agree?
pnpm calibrate --write-results       # live: runs the judge, stores its scores in calibration-results.json
pnpm check:calibration               # offline: the CI gate (also part of `pnpm check`)
```

**`calibration:validate`** needs no API keys. It reports every problem with the repo it belongs to
(commit SHA not 40 hex characters, a missing second scorer, a skill id that is not in the taxonomy,
a duplicate repo, a score outside 1-5) and exits 1 on any. It then prints how often the two people
agree: exact, within one level, mean difference, and every dimension where they differ by more than
one level (a warning; `--strict` makes warnings fail). If `calibration-results.json` is present and
fresh it also prints judge-vs-human per repo and the `within +-1 on N of 10` line.

**`calibrate --write-results`** runs the judge as before and additionally writes
`calibration-results.json` next to the set. That file holds **model output only**: the judge's
repo-level scores, the commit it actually read, the model name and the four version identifiers,
plus a digest of the human labels it was compared against. Commit it; CI cannot call Gemini.

**`check:calibration`** is the gate, and it never touches the network:

- fewer than 10 entries: prints `PENDING` and exits 0. Accuracy is **not** being measured yet.
- 10 entries: exits 1 unless the set is valid, `calibration-results.json` exists and is fresh, and the
  judge is within +-1 of the human mean on at least 8 of 10 repos.

"Fresh" means the stored results still describe what is in the repo. The gate fails if the human
labels were edited after the judge ran (digest mismatch), if the prompt, taxonomy, rubric or sampler
version has changed since (re-run after every such change, as above), if the judge read a different
commit than the humans scored, or if a repo is missing from the results. Editing a score to rescue a
failing run therefore does not work: it invalidates the results and forces a re-run. A repo the judge
could not read counts as a miss, not an error.

