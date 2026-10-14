import type { PersonProfile, ProfileJudgment } from "@talentradar/shared";
import type { RepositoryFacts } from "../profile-pipeline/judge.js";

/** Plain-text renderers shared by the diagnostic CLIs. */

export function formatMatches(matches: ReadonlyArray<{ id: string; reasons: string[] }>): string[] {
  return matches.length === 0
    ? ["  (no technology matched)"]
    : matches.map((match) => `  ${match.id.padEnd(22)} ${match.reasons.join(", ")}`);
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

type IncludedFacts = Extract<RepositoryFacts, { included: true }>;

/** Stage-2 facts; GitHub-only facts are optional because a local checkout does not have them. */
export type FactsView = Omit<IncludedFacts, "included" | "authorship" | "pushedAt"> &
  Partial<Pick<IncludedFacts, "authorship" | "pushedAt">>;

export function formatSkipped(repository: Extract<RepositoryFacts, { included: false }>): string {
  return `${repository.repository}: skipped (${repository.exclusionReason})`;
}

export function formatFacts(repository: FactsView): string[] {
  const unknown = "(not known for a local checkout)";
  const total = Object.values(repository.languages).reduce((sum, bytes) => sum + bytes, 0);
  const languages = Object.entries(repository.languages)
    .sort((left, right) => right[1] - left[1])
    .map(([language, bytes]) => `${language} ${percent(total > 0 ? bytes / total : 0)}`)
    .join(", ");
  const sampledCharacters = repository.selectedFiles.reduce(
    (sum, file) => sum + file.content.length,
    0,
  );
  return [
    `${repository.repository} @ ${repository.commitSha.slice(0, 12)}`,
    `  languages   ${languages || unknown}`,
    `  authorship  ${repository.authorship === undefined ? unknown : percent(repository.authorship)}`,
    `  last push   ${repository.pushedAt ?? unknown}`,
    `  tests ${repository.hasTests ? "yes" : "no"} · CI ${repository.hasCi ? "yes" : "no"} · containerized ${repository.containerized ? "yes" : "no"}`,
    `  readme      ${repository.readmePath ?? "(none)"}`,
    `  tree        ${repository.tree.length} entries (two levels deep)`,
    "  technology hints:",
    ...formatMatches(repository.technologyMatches).map((line) => `  ${line}`),
    `  sampled files (${repository.selectedFiles.length}, ~${Math.ceil(sampledCharacters / 4)} tokens):`,
    ...repository.selectedFiles.map((file) => `    ${file.path} (${file.content.length} chars)`),
  ];
}

export function formatProfile(
  login: string,
  judgment: ProfileJudgment,
  profile: PersonProfile,
): string[] {
  const lines = [`@${login}: ${judgment.summary}`, `  ${judgment.thoughts}`, "", "Repositories:"];
  for (const repository of judgment.repos) {
    lines.push(
      `  ${repository.repo} @ ${repository.commitSha.slice(0, 12)}  originality ${repository.originality}  authorship ${percent(repository.authorship)}`,
    );
  }
  lines.push("", "Skills (level · confidence · effective):");
  for (const skill of profile.skills) {
    lines.push(
      `  ${skill.id.padEnd(22)} ${skill.level.toFixed(2)} · ${skill.confidence} · ${skill.effective.toFixed(2)}`,
    );
    for (const item of skill.evidence) {
      lines.push(
        `    - ${item.repository}@${item.commitSha.slice(0, 7)}:${item.path}  ${item.note}`,
      );
    }
    if (skill.thought) lines.push(`    thought: ${skill.thought}`);
  }
  if (judgment.cv.claims.length > 0) {
    lines.push("", "CV claims:");
    for (const claim of judgment.cv.claims) {
      lines.push(`  ${claim.id} (${claim.level}): "${claim.quote}"  ${claim.thought}`);
    }
  }
  lines.push(
    "",
    ...(profile.summary ? [`Summary: ${profile.summary}`] : []),
    `Novelty: ${profile.novelty}`,
    `Flags: ${profile.flags.length > 0 ? profile.flags.join(", ") : "none"}`,
  );
  return lines;
}
