import type { ProfileJudgment } from "./aggregate.js";

type Flag = ProfileJudgment["flags"][number];

/**
 * Lower median: the middle value, and for an even count the lower of the two middle values.
 * Levels are integers on a 1 to 5 rubric, so averaging two judges would invent a level nobody
 * gave. Taking the lower one is deliberately conservative: when two judges disagree, the person
 * is credited with what both could defend, never with the more generous reading alone.
 */
export function lowerMedian(values: readonly number[]): number {
  if (values.length === 0) throw new Error("lowerMedian needs at least one value");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** True when strictly more than half of the judgments agree: 2 of 2, 2 of 3, 3 of 4. */
function isMajority(count: number, total: number): boolean {
  return count * 2 > total;
}

/**
 * Collects the entries each judgment holds under a key, in the order keys are first seen so the
 * first judgment (the primary one) decides ordering.
 */
function groupByKey<T>(
  lists: ReadonlyArray<readonly T[]>,
  keyOf: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const item of list) {
      const key = keyOf(item);
      if (seen.has(key)) continue; // a judge listing the same key twice counts once
      seen.add(key);
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
  }
  return groups;
}

/** The entry whose level equals the merged level, so its evidence and reasoning stay coherent. */
function entryAtLevel<T extends { level: number }>(entries: readonly T[], level: number): T {
  return (entries.find((entry) => entry.level === level) ?? entries[0]) as T;
}

/**
 * Merges independent judgments of the same profile into one, per field:
 *
 * - repository, skill and CV claim: kept only when a strict majority of judges produced it (with
 *   two judges, both), so one judge's unconfirmed finding cannot add coverage;
 * - levels, originality and authorship: the lower median of the judges that produced it;
 * - evidence and reasoning: taken from a judge whose level matches the merged level;
 * - flags: `possible_prompt_injection` if ANY judge raised it, since it is a safety signal and a
 *   missed detection is the costly error; every other flag by majority;
 * - thoughts and summary: the first judgment's, which is the primary assessment.
 *
 * One judgment merges to itself. The result always satisfies ProfileJudgmentSchema.
 */
export function mergeJudgments(judgments: readonly ProfileJudgment[]): ProfileJudgment {
  const [primary] = judgments;
  if (!primary) throw new Error("mergeJudgments needs at least one judgment");
  if (judgments.length === 1) return primary;
  const total = judgments.length;

  const repoGroups = groupByKey(
    judgments.map((judgment) => judgment.repos),
    (repo) => repo.repo,
  );
  const repos: ProfileJudgment["repos"] = [];
  for (const entries of repoGroups.values()) {
    if (!isMajority(entries.length, total)) continue;
    const first = entries[0] as ProfileJudgment["repos"][number];
    const skillGroups = groupByKey(
      entries.map((entry) => entry.skills),
      (skill) => skill.id,
    );
    const skills: ProfileJudgment["repos"][number]["skills"] = [];
    for (const skillEntries of skillGroups.values()) {
      if (!isMajority(skillEntries.length, entries.length)) continue;
      const level = lowerMedian(skillEntries.map((skill) => skill.level));
      const source = entryAtLevel(skillEntries, level);
      skills.push({ ...source, level });
    }
    repos.push({
      repo: first.repo,
      commitSha: first.commitSha,
      pushedAt: first.pushedAt,
      authorship: lowerMedian(entries.map((entry) => entry.authorship)),
      originality: lowerMedian(entries.map((entry) => entry.originality)),
      skills,
    });
  }

  const claimGroups = groupByKey(
    judgments.map((judgment) => judgment.cv.claims),
    (claim) => claim.id,
  );
  const claims: ProfileJudgment["cv"]["claims"] = [];
  for (const entries of claimGroups.values()) {
    if (!isMajority(entries.length, total)) continue;
    const level = lowerMedian(entries.map((claim) => claim.level));
    claims.push({ ...entryAtLevel(entries, level), level });
  }

  const flagCounts = new Map<Flag, number>();
  for (const judgment of judgments) {
    for (const flag of new Set(judgment.flags)) {
      flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
    }
  }
  const flags = [...flagCounts.entries()]
    .filter(([flag, count]) => flag === "possible_prompt_injection" || isMajority(count, total))
    .map(([flag]) => flag);

  return {
    thoughts: primary.thoughts,
    summary: primary.summary,
    repos,
    cv: { claims },
    flags,
  };
}

export interface JudgmentDisagreement {
  /** Repository skills and CV claims every judge rated. */
  comparedSkills: number;
  /** Mean absolute gap between the highest and lowest level among compared skills. */
  meanLevelGap: number;
  maxLevelGap: number;
  /** Skills some judges rated and others did not mention at all. */
  skillsInOnlySome: number;
  flagsDiffer: boolean;
}

/**
 * How far apart the judges were, for triage and the organizer's evidence view. Zero gaps with
 * nothing in only some means the second opinion simply confirmed the first.
 */
export function judgmentDisagreement(judgments: readonly ProfileJudgment[]): JudgmentDisagreement {
  const levelsByKey = new Map<string, number[]>();
  for (const judgment of judgments) {
    const seen = new Set<string>();
    const add = (key: string, level: number) => {
      if (seen.has(key)) return;
      seen.add(key);
      levelsByKey.set(key, [...(levelsByKey.get(key) ?? []), level]);
    };
    for (const repo of judgment.repos) {
      for (const skill of repo.skills) add(`repo:${repo.repo}:${skill.id}`, skill.level);
    }
    for (const claim of judgment.cv.claims) add(`cv:${claim.id}`, claim.level);
  }
  let comparedSkills = 0;
  let skillsInOnlySome = 0;
  let gapTotal = 0;
  let maxLevelGap = 0;
  for (const levels of levelsByKey.values()) {
    if (levels.length < judgments.length) {
      skillsInOnlySome += 1;
      continue;
    }
    const gap = Math.max(...levels) - Math.min(...levels);
    comparedSkills += 1;
    gapTotal += gap;
    maxLevelGap = Math.max(maxLevelGap, gap);
  }
  const flagSets = judgments.map((judgment) => [...new Set(judgment.flags)].sort().join(","));
  return {
    comparedSkills,
    meanLevelGap: comparedSkills === 0 ? 0 : gapTotal / comparedSkills,
    maxLevelGap,
    skillsInOnlySome,
    flagsDiffer: new Set(flagSets).size > 1,
  };
}
