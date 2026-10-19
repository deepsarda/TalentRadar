import { originalityRubric } from "@talentradar/shared";
import type { ParticipantProfileResponse } from "../lib/api";
import { Details, Notice, Pane, Stat } from "./ui";

const flagLabels: Record<string, string> = {
  possible_prompt_injection: "Instruction-like content was flagged for review.",
  readme_overclaims: "README claims exceed the code evidence.",
  mostly_boilerplate: "Most reviewed code is scaffolding.",
};

export function ProfileInsights({
  profile,
  showRepositoryCount = true,
}: {
  profile: ParticipantProfileResponse["profile"];
  showRepositoryCount?: boolean;
}) {
  const signal =
    profile.novelty >= 1
      ? "Novel work"
      : profile.novelty >= 0.25
        ? "Original work"
        : "No qualifying evidence";
  const repositories = profile.assessment?.repositories ?? [];
  return (
    <Pane
      title="originality"
      meta={
        <>
          <span className="sm:hidden">AI</span>
          <span className="hidden sm:inline">model assessment</span>
        </>
      }
    >
      <div className="grid gap-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:flex sm:flex-wrap sm:gap-x-12">
          <div className="col-span-2 grid content-center gap-1">
            <span className="font-display text-3xl text-accent glow">{signal}</span>
            <span className="dim">novelty signal</span>
          </div>
          {showRepositoryCount ? (
            <Stat
              value={profile.repos.filter((repo) => repo.included).length}
              label="repositories reviewed"
            />
          ) : null}
          <Stat value={profile.flags.length} label="review flags" />
        </div>
        <p className="dim max-w-prose">
          The strongest original or novel project determines this signal. It qualifies when its code
          demonstrates at least one skill at level 3 or above.
        </p>

        {profile.assessment?.thoughts ? (
          <div className="grid max-w-prose gap-1">
            <h3 className="dim font-normal">assessment explanation</h3>
            <p>{profile.assessment.thoughts}</p>
          </div>
        ) : null}

        {repositories.length > 0 ? (
          <ul className="grid gap-4 border-line border-t pt-4" aria-label="Repository originality">
            {repositories.map((repository) => {
              const rubric = originalityRubric.find(
                (entry) => entry.level === repository.originality,
              );
              return (
                <li key={repository.repository} className="grid gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <a
                      className="tui-link break-all text-fg!"
                      href={`https://github.com/${repository.repository}/tree/${repository.commitSha}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {repository.repository} ↗
                    </a>
                    <span>
                      {repository.originality}/5 · {rubric?.name ?? "Originality"}
                    </span>
                  </div>
                  <p className="dim">{rubric?.anchor}</p>
                  <p className="dim text-sm">
                    GitHub commit share: {Math.round(repository.authorship * 100)}%
                    {repository.qualifiesForNovelty
                      ? " · contributes to novelty"
                      : repository.originality >= 4
                        ? " · needs level 3+ skill evidence to contribute to novelty"
                        : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="dim">Repository originality scores are unavailable for this build.</p>
        )}

        {profile.flags.length > 0 ? (
          <Notice tone="warn" tag="review">
            <span className="grid gap-1">
              {profile.flags.map((flag) => (
                <span key={flag}>{flagLabels[flag] ?? flag.replaceAll("_", " ")}</span>
              ))}
            </span>
          </Notice>
        ) : null}

        <Details summary="originality rubric">
          <dl className="grid gap-3">
            {originalityRubric.map((entry) => (
              <div key={entry.level}>
                <dt>
                  {entry.level}/5 · {entry.name}
                </dt>
                <dd className="dim">{entry.anchor}</dd>
              </div>
            ))}
          </dl>
        </Details>
      </div>
    </Pane>
  );
}
