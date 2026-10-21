import {
  type DecidedTeam,
  type PersonProfile,
  pseudonymizePersonName,
  type QuotaReport,
  type QuotaSwap,
  type RankedTeam,
  type RankingParams,
  rank,
  redactTeamForBlindReview,
  type SelectionOverride,
  selectShortlist,
  type Team,
} from "@talentradar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import { ProfileModal } from "../components/ProfileModal";
import { useStatusLine } from "../components/statusline";
import {
  ActionAnchor,
  ActionButton,
  ActionLink,
  Avatar,
  Bar,
  Details,
  EmptyState,
  Field,
  formatDateTime,
  KeyValue,
  LoadingState,
  Notice,
  Pane,
  Prompt,
  ScreenHead,
  SkillGroups,
  Slider,
  Stat,
  StateTag,
  Status,
  TextAction,
  TextInput,
} from "../components/ui";
import {
  getCurrentUser,
  getOrganizerShortlist,
  getOrganizerShortlistRun,
  getProfileFailures,
  getTeamGapFillers,
  type OrganizerShortlistRun,
  type OrganizerShortlistTeam,
  publishOrganizerShortlistRun,
  retryProfileFailure,
  type ShortlistRunPerson,
  saveOrganizerShortlistRun,
} from "../lib/api";
import { compareRuns, type RunComparison } from "../lib/compare-runs";
import { evidenceUrl } from "../lib/evidence";
import { shortcutBlocked } from "../lib/keys";
import { skillLabel } from "../lib/skills";

/**
 * The spec's what-if line: re-run rank() with one requirement's weight set to 0 and report
 * the team's new position. Null when the team would be ineligible, or when that requirement
 * carries all the weight (nothing would be left to score).
 */
export function whatIfRank(
  profiles: readonly PersonProfile[],
  teams: readonly Team[],
  params: RankingParams,
  teamId: string,
  skill: string,
): number | null {
  const requirements = params.requirements.map((requirement) =>
    requirement.skill === skill ? { ...requirement, weight: 0 } : requirement,
  );
  if (requirements.every((requirement) => requirement.weight === 0)) return null;
  const ranked = rank(profiles, teams, { ...params, requirements });
  return ranked.find((team) => team.teamId === teamId)?.rank ?? null;
}

/** Mirrors withIneligibleNotes in the shortlist API, so local re-ranks match a saved run. */
export function withIneligibleNotes(
  ranked: RankedTeam[],
  notes: Readonly<Record<string, string>> = {},
): RankedTeam[] {
  return ranked.map((team) => {
    const note = notes[team.teamId];
    return note && !team.eligible
      ? { ...team, ineligibleReasons: [note, ...team.ineligibleReasons] }
      : team;
  });
}

const actionWords: Record<SelectionOverride["action"], string> = {
  pin_in: "pinned in",
  pin_out: "pinned out",
};

export const reviewFlagLabels: Record<string, { label: string; description: string }> = {
  possible_prompt_injection: {
    label: "Prompt injection",
    description:
      "Source code or CV text includes phrasing intended to direct the automated evaluator.",
  },
  readme_overclaims: {
    label: "Readme overclaims",
    description:
      "README promises substantial functionality that is not substantiated in committed code.",
  },
  mostly_boilerplate: {
    label: "Mostly boilerplate",
    description:
      "The majority of repository code originates from scaffolding, templates, or vendored assets.",
  },
  unverified_cv_claims: {
    label: "Unverified CV claim",
    description:
      "Skills or technologies claimed on the CV that lack direct repository commit evidence.",
  },
};

/** Compact sliders restacked as `label  value` over a full-width track, for grid cells. */
const sliderGrid =
  "grid grid-cols-2 items-start gap-x-5 gap-y-4 sm:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] sm:gap-x-8 [&_.slider.compact]:grid-cols-[minmax(0,1fr)_auto] [&_.slider.compact]:gap-y-1 [&_.slider.compact_input]:col-span-2 [&_.slider.compact_input]:row-start-2";

function sentence(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A titled group inside "more settings". */
function Group({
  title,
  action,
  children,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <section className="grid gap-3">
      <h3 className="flex items-baseline justify-between gap-2 dim">
        {title}
        {action}
      </h3>
      {children}
    </section>
  );
}

/** Every quota collapsed to one line: the single message, or a met/unmet count. */
function QuotaLine({
  reports,
  swaps,
}: {
  reports: readonly QuotaReport[];
  swaps: readonly QuotaSwap[];
}) {
  if (reports.length === 0) return null;
  const unmet = reports.filter((report) => !report.met);
  const text =
    reports.length === 1
      ? sentence(reports[0]?.message ?? "")
      : unmet.length === 0
        ? `All ${reports.length} quotas met`
        : `${unmet.length} of ${reports.length} quotas unmet: ${unmet[0]?.message}`;
  return (
    <p className="truncate" title={reports.map((report) => report.message).join("\n")}>
      <span aria-hidden="true" className={unmet.length ? "text-error" : "text-accent"}>
        {unmet.length ? "✗ " : "✓ "}
      </span>
      <span className="sr-only">{unmet.length ? "Quotas not met: " : "Quotas met: "}</span>
      {text}
      {swaps.length ? (
        <span className="dim">
          {" "}
          · {swaps.length} swap{swaps.length === 1 ? "" : "s"}
        </span>
      ) : null}
    </p>
  );
}

/** Full-width rule between the last selected team and the rest. */
function CutoffRow({ score, columns }: { score: number; columns: number }) {
  return (
    <tr className="pointer-events-none border-0 py-0">
      <td colSpan={columns} className="py-0 text-accent">
        <span className="flex w-full items-center gap-[1ch] text-xs">
          <span className="h-px flex-1 bg-accent" />
          cutoff {score.toFixed(1)}
          <span className="h-px flex-1 bg-accent" />
        </span>
      </td>
    </tr>
  );
}

/** The decision word, with the waitlist position when there is one. */
function DecisionTag({ result }: { result: DecidedTeam }) {
  return result.status === "waitlisted" ? (
    <StateTag state="waitlisted" label={`waitlist #${result.waitlistPosition}`} />
  ) : (
    <StateTag state={result.status} />
  );
}

function TeamTags({ result, flags = [] }: { result: DecidedTeam; flags?: string[] }) {
  const reason = result.status === "ineligible" ? result.ineligibleReasons[0] : undefined;
  if (!result.borderline && !result.quotaSwap && !result.override && !reason && flags.length === 0)
    return null;
  return (
    <span className="flex flex-wrap gap-x-[1ch] text-xs">
      {reason ? <span className="dim">{reason.split(":")[0]}</span> : null}
      {result.borderline ? <Status tone="warn">review</Status> : null}
      {flags.map((flag) => {
        const meta = reviewFlagLabels[flag];
        return (
          <Status tone="warn" key={flag} title={meta?.description}>
            {meta?.label ?? flag.replaceAll("_", " ")}
          </Status>
        );
      })}
      {result.quotaSwap ? (
        <Status tone="info">{result.quotaSwap === "added" ? "quota in" : "quota out"}</Status>
      ) : null}
      {result.override ? <Status tone="info">{actionWords[result.override.action]}</Status> : null}
    </span>
  );
}

function decisionSentence(
  result: DecidedTeam,
  seats: number,
  cutoff: { score: number; rank: number | null } | null,
): string {
  if (result.status === "ineligible") {
    return `Ineligible: ${result.ineligibleReasons.join("; ").toLowerCase()}.`;
  }
  if (result.status === "selected") {
    if (result.override?.action === "pin_in") return `Pinned in. Takes ${seats} seats.`;
    if (result.quotaSwap === "added") return `Selected by a quota swap. Takes ${seats} seats.`;
    return `Selected. Takes ${seats} seats.`;
  }
  const waitlist =
    result.status === "waitlisted" ? ` Waitlisted at position #${result.waitlistPosition}.` : "";
  if (result.override?.action === "pin_out") return `Pinned out.${waitlist}`;
  if (result.quotaSwap === "removed") return `Replaced by a quota swap.${waitlist}`;
  if (!cutoff) return `Not selected.${waitlist}`;
  const gap = cutoff.score - result.score;
  const where = `${cutoff.score.toFixed(1)}${cutoff.rank ? `, rank ${cutoff.rank}` : ""}`;
  if (gap <= 0) {
    return `Above the cutoff (${where}) but no seats left.${waitlist}`;
  }
  return `Missed the cutoff (${where}) by ${gap.toFixed(1)} points.${waitlist}`;
}

const noveltyWords: Record<string, string> = {
  "1": "originality 5",
  "0.25": "originality 4",
};

const tableColumns = 5;

function CompareRunsModal({
  eventId,
  runs,
  onClose,
}: {
  eventId: string;
  runs: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const [runAId, setRunAId] = useState(runs[0]?.id ?? "");
  const [runBId, setRunBId] = useState(runs[1]?.id ?? runs[0]?.id ?? "");

  const queryA = useQuery({
    queryKey: ["organizer-shortlist-run", eventId, runAId],
    queryFn: () => getOrganizerShortlistRun(eventId, runAId),
    enabled: Boolean(eventId && runAId),
  });

  const queryB = useQuery({
    queryKey: ["organizer-shortlist-run", eventId, runBId],
    queryFn: () => getOrganizerShortlistRun(eventId, runBId),
    enabled: Boolean(eventId && runBId),
  });

  const comparison = useMemo<RunComparison | null>(() => {
    if (!queryA.data || !queryB.data) return null;
    return compareRuns(queryA.data, queryB.data);
  }, [queryA.data, queryB.data]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col border border-dim bg-bg p-6 text-text shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
          <h2 className="text-lg font-semibold">Compare runs</h2>
          <TextAction tone="danger" onClick={onClose}>
            [close]
          </TextAction>
        </div>

        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <Field label="Baseline Run (A)">
            <select
              className="w-full border border-dim bg-transparent p-2 text-text"
              value={runAId}
              onChange={(e) => setRunAId(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id} className="bg-bg text-text">
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target Run (B)">
            <select
              className="w-full border border-dim bg-transparent p-2 text-text"
              value={runBId}
              onChange={(e) => setRunBId(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id} className="bg-bg text-text">
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {queryA.isPending || queryB.isPending ? (
          <LoadingState label="Loading runs to compare…" />
        ) : comparison ? (
          <div className="flex-1 overflow-y-auto space-y-6 pr-2">
            {comparison.parameterChanges.length > 0 ? (
              <div className="border border-dim/50 p-3">
                <span className="text-xs font-bold uppercase text-dim">Parameter changes</span>
                <ul className="mt-1 list-inside list-disc text-sm text-text">
                  {comparison.parameterChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Moved In" value={comparison.movedIn.length} />
              <Stat label="Moved Out" value={comparison.movedOut.length} />
              <Stat label="Moved Up" value={comparison.movedUp.length} />
              <Stat label="Moved Down" value={comparison.movedDown.length} />
            </div>

            <div className="space-y-4">
              {comparison.movedIn.length > 0 ? (
                <div>
                  <h3 className="text-sm font-bold text-accent">
                    + MOVED IN ({comparison.movedIn.length})
                  </h3>
                  <div className="mt-2 divide-y divide-line border border-dim">
                    {comparison.movedIn.map((t) => (
                      <div
                        key={t.teamId}
                        className="p-3 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
                      >
                        <div>
                          <span className="font-bold text-text">{t.name}</span>
                          <span className="ml-2 dim text-xs">
                            {t.previousStatus} → <StateTag state="selected" />
                          </span>
                        </div>
                        <span className="text-xs text-dim">
                          {t.reasons.join("; ") || "Selected"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {comparison.movedOut.length > 0 ? (
                <div>
                  <h3 className="text-sm font-bold text-error">
                    - MOVED OUT ({comparison.movedOut.length})
                  </h3>
                  <div className="mt-2 divide-y divide-line border border-dim">
                    {comparison.movedOut.map((t) => (
                      <div
                        key={t.teamId}
                        className="p-3 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
                      >
                        <div>
                          <span className="font-bold text-text">{t.name}</span>
                          <span className="ml-2 dim text-xs">
                            selected →{" "}
                            <StateTag
                              state={t.currentStatus === "none" ? "not_selected" : t.currentStatus}
                            />
                          </span>
                        </div>
                        <span className="text-xs text-dim">
                          {t.reasons.join("; ") || "Dropped below cutoff"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {comparison.movedUp.length > 0 || comparison.movedDown.length > 0 ? (
                <div>
                  <h3 className="text-sm font-bold text-warn">
                    ↕ RANK SHIFTS ({comparison.movedUp.length + comparison.movedDown.length})
                  </h3>
                  <div className="mt-2 divide-y divide-line border border-dim">
                    {[...comparison.movedUp, ...comparison.movedDown].map((t) => (
                      <div
                        key={t.teamId}
                        className="p-3 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
                      >
                        <div>
                          <span className="font-bold text-text">{t.name}</span>
                          <span className="ml-2 text-xs font-mono">
                            {t.rankDelta > 0 ? (
                              <span className="text-accent">
                                ▲ +{t.rankDelta} (#{t.previousRank} → #{t.currentRank})
                              </span>
                            ) : (
                              <span className="text-error">
                                ▼ {t.rankDelta} (#{t.previousRank} → #{t.currentRank})
                              </span>
                            )}
                          </span>
                        </div>
                        <span className="text-xs text-dim">{t.reasons.join("; ")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {comparison.movedIn.length === 0 &&
              comparison.movedOut.length === 0 &&
              comparison.movedUp.length === 0 &&
              comparison.movedDown.length === 0 ? (
                <EmptyState title="No ranking or selection changes between these two runs." />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SimulationLabModal({
  tune,
  preview,
  runName,
  onRunName,
  saving,
  saveError,
  savedCount,
  onSave,
  onCompare,
  onClose,
}: {
  tune: ReactNode;
  preview?: ReactNode;
  runName: string;
  onRunName: (name: string) => void;
  saving: boolean;
  saveError: string | null;
  savedCount: number;
  onSave: () => void;
  onCompare: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col border border-dim bg-bg p-6 text-text shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
          <div>
            <h2 className="text-lg font-semibold">Simulation lab</h2>
            <p className="text-xs text-dim">
              Change the values, the ranking re-runs at once, then save it as a version to compare ·
              0 LLM calls
            </p>
          </div>
          <TextAction tone="danger" onClick={onClose}>
            [close]
          </TextAction>
        </div>

        <div className="overflow-y-auto pr-1">
          <div className="grid gap-6">
            {tune}

            {preview}

            <div className="grid gap-3 border border-dim/50 p-4">
              <h3 className="text-sm font-bold uppercase text-dim">Save as version</h3>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="version name" hint="Shown in Compare runs">
                  <TextInput
                    value={runName}
                    maxLength={80}
                    onChange={(event) => onRunName(event.target.value)}
                  />
                </Field>
                <ActionButton
                  tone="primary"
                  disabled={saving || runName.trim().length < 2}
                  onClick={onSave}
                >
                  {saving ? "Saving…" : "Save as version"}
                </ActionButton>
                <ActionButton
                  disabled={savedCount < 2}
                  title={
                    savedCount < 2
                      ? "Save at least two versions to compare them"
                      : "Compare two saved versions side-by-side"
                  }
                  onClick={onCompare}
                >
                  Compare{savedCount < 2 ? ` (${savedCount}/2 saved)` : ""}
                </ActionButton>
              </div>
              {saveError ? (
                <Notice tone="error" tag="error">
                  {saveError}
                </Notice>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PublishConfirmModal({
  runName,
  registrationClosesAt,
  isPending,
  error,
  onConfirm,
  onClose,
}: {
  runName: string;
  registrationClosesAt?: string | undefined;
  isPending: boolean;
  error?: string | null | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const isRegistrationOpen = registrationClosesAt
    ? new Date(registrationClosesAt).getTime() > Date.now()
    : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col border border-dim bg-bg p-6 text-text shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
          <div>
            <h2 className="text-lg font-semibold text-rose-400">Publish Final Shortlist</h2>
            <p className="text-xs text-dim">Permanent announcement for {runName}</p>
          </div>
          <TextAction tone="danger" onClick={onClose} disabled={isPending}>
            [close]
          </TextAction>
        </div>

        <div className="space-y-4 text-sm text-dim">
          <p className="font-medium text-text">
            Publishing officially finalizes this shortlist for the hackathon. Here is what will
            happen:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-xs text-dim">
            <li>
              <strong className="text-text">Locks all teams:</strong> Rosters are permanently frozen
              and cannot be edited.
            </li>
            <li>
              <strong className="text-text">Updates statuses:</strong> Selected candidates move to{" "}
              <span className="font-semibold text-emerald-400">selected</span>, waitlisted to{" "}
              <span className="font-semibold text-amber-400">waitlisted</span>, and others to{" "}
              <span className="font-semibold text-zinc-400">not_selected</span>.
            </li>
            <li>
              <strong className="text-text">Notifies participants:</strong> Automated
              acceptance/waitlist emails are dispatched with RSVP instructions.
            </li>
            <li>
              <strong className="text-text">Closes registration:</strong> The event is officially
              closed to new applications.
            </li>
          </ul>

          {isRegistrationOpen ? (
            <Notice tone="error" tag="blocked">
              Registration is still open! Registration closes at{" "}
              {registrationClosesAt
                ? new Date(registrationClosesAt).toLocaleString()
                : "a future date"}
              . The final shortlist cannot be published until registration has closed.
            </Notice>
          ) : (
            <Notice tone="warn" tag="warning">
              This action is permanent and cannot be undone once published.
            </Notice>
          )}

          {error ? (
            <Notice tone="error" tag="error">
              {error}
            </Notice>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3 border-t border-line pt-4">
          <ActionButton onClick={onClose} disabled={isPending}>
            Cancel
          </ActionButton>
          <ActionButton
            tone="danger"
            disabled={isPending || isRegistrationOpen}
            onClick={onConfirm}
          >
            {isPending ? "Publishing…" : "Confirm & Publish Final Shortlist"}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

export function ShortlistWorkspacePage() {
  const { eventId } = useParams();
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const [alpha, setAlpha] = useState(0.7);
  const [novelty, setNovelty] = useState(10);
  const [minFit, setMinFit] = useState(0);
  const [capacity, setCapacity] = useState(100);
  const [waitlist, setWaitlist] = useState(10);
  const [confidenceFactors, setConfidenceFactors] = useState({
    high: 1,
    medium: 0.85,
    low: 0.6,
  });
  const [requirements, setRequirements] = useState<RankingParams["requirements"]>([]);
  const [overrides, setOverrides] = useState<SelectionOverride[]>([]);
  const [overrideReason, setOverrideReason] = useState("");
  const [runName, setRunName] = useState("Run 1");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [comparingRuns, setComparingRuns] = useState(false);
  const [blindEvaluation, setBlindEvaluation] = useState(true);
  const [simLabOpen, setSimLabOpen] = useState(false);
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
  // The cursor row, and whether its inspector row is open beneath it. The inspector follows the
  // cursor, so only one team is ever expanded.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [profileTeamId, setProfileTeamId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const scrollToSelection = useRef(false);
  const account = useQuery({ queryKey: ["current-user"], queryFn: getCurrentUser, retry: false });
  const user = account.data ? { user: account.data.login } : {};
  const shortlist = useQuery({
    queryKey: ["organizer-shortlist", eventId],
    queryFn: () => getOrganizerShortlist(eventId ?? ""),
    enabled: Boolean(eventId),
    retry: false,
  });

  useEffect(() => {
    if (!shortlist.data) return;
    const { ranking } = shortlist.data.event;
    setAlpha(ranking.alpha);
    setNovelty(ranking.noveltyWeight);
    setMinFit(ranking.minFit);
    setConfidenceFactors(ranking.confidenceFactors);
    setRequirements(ranking.requirements);
    setCapacity(shortlist.data.event.capacity);
    setWaitlist(Math.min(500, Math.ceil(shortlist.data.teams.length * 0.2)));
    setRunName(`Run ${shortlist.data.runs.length + 1}`);

    if (shortlist.data.runs.length > 0) {
      setActiveRunId((current) => {
        if (current) return current;
        const published = shortlist.data?.runs.find((r) => r.published);
        return published?.id ?? shortlist.data?.runs[0]?.id ?? null;
      });
    }
  }, [shortlist.data]);

  const baselineRankingParams = useMemo<RankingParams | null>(() => {
    return shortlist.data?.event.ranking ?? null;
  }, [shortlist.data]);

  const baselineRanks = useMemo<Map<string, number>>(() => {
    if (!shortlist.data || !baselineRankingParams) return new Map();
    try {
      const ranked = rank(
        shortlist.data.profiles,
        shortlist.data.rankingTeams,
        baselineRankingParams,
      );
      return new Map(ranked.map((t) => [t.teamId, t.rank ?? 9999]));
    } catch {
      return new Map();
    }
  }, [shortlist.data, baselineRankingParams]);

  const isSimulated = useMemo(() => {
    const defaults = shortlist.data?.event.ranking;
    if (!defaults || !shortlist.data) return false;
    return (
      Math.abs(alpha - defaults.alpha) > 0.001 ||
      novelty !== defaults.noveltyWeight ||
      Math.abs(minFit - defaults.minFit) > 0.001 ||
      capacity !== shortlist.data.event.capacity ||
      requirements.some((r) => {
        const d = defaults.requirements.find((dr) => dr.skill === r.skill);
        return !d || d.weight !== r.weight || d.target !== r.target;
      })
    );
  }, [alpha, novelty, minFit, capacity, requirements, shortlist.data]);

  const resetToDefaults = () => {
    if (!shortlist.data) return;
    const { ranking } = shortlist.data.event;
    setAlpha(ranking.alpha);
    setNovelty(ranking.noveltyWeight);
    setMinFit(ranking.minFit);
    setConfidenceFactors(ranking.confidenceFactors);
    setRequirements(ranking.requirements);
    setCapacity(shortlist.data.event.capacity);
    setWaitlist(Math.min(500, Math.ceil(shortlist.data.teams.length * 0.2)));
    setActiveRunId(null);
    post("Reset parameters to event defaults");
  };

  const loadSavedRun = async (runSummary: { id: string; name: string }) => {
    try {
      setActiveRunId(runSummary.id);
      const fullRun = await getOrganizerShortlistRun(eventId ?? "", runSummary.id);
      if (fullRun?.params) {
        setAlpha(fullRun.params.alpha);
        setNovelty(fullRun.params.noveltyWeight);
        setMinFit(fullRun.params.minFit);
        setConfidenceFactors(fullRun.params.confidenceFactors);
        setRequirements(fullRun.params.requirements);
      }
      if (fullRun?.selection) {
        setCapacity(fullRun.selection.capacity);
        setWaitlist(fullRun.selection.waitlistSize);
      }
      if (fullRun?.overrides) {
        setOverrides(
          fullRun.overrides.map((o) => ({
            teamId: o.teamId,
            action: o.action,
            reason: o.reason,
          })),
        );
      }
      post(`Loaded ${runSummary.name}`);
    } catch {
      setActiveRunId(runSummary.id);
    }
  };

  const rankingParams = useMemo<RankingParams | null>(() => {
    const defaults = shortlist.data?.event.ranking;
    if (!defaults || requirements.length === 0) return null;
    return {
      ...defaults,
      requirements,
      alpha,
      noveltyWeight: novelty,
      confidenceFactors,
      minFit,
    };
  }, [alpha, confidenceFactors, minFit, novelty, requirements, shortlist.data]);

  // rank() and selectShortlist() throw on invalid input (an emptied capacity field, a confidence
  // factor above 1, pins beyond capacity). Catch it so a half-typed number shows an error line
  // instead of unmounting the screen.
  const pipeline = useMemo(() => {
    if (!shortlist.data || !rankingParams) return { decision: null, error: null };
    try {
      const ranked = withIneligibleNotes(
        rank(shortlist.data.profiles, shortlist.data.rankingTeams, rankingParams),
        shortlist.data.ineligibleNotes,
      );
      const decision = selectShortlist(ranked, shortlist.data.teams, {
        capacity,
        waitlistSize: waitlist,
        quotas: shortlist.data.event.quotas,
        overrides,
      });
      return { decision, error: null };
    } catch (error) {
      return {
        decision: null,
        error: error instanceof Error ? error.message : "These parameters cannot be ranked",
      };
    }
  }, [capacity, overrides, rankingParams, shortlist.data, waitlist]);
  const { decision } = pipeline;

  useEffect(() => {
    if (!decision?.results.length) {
      setSelectedTeamId(null);
      return;
    }
    if (!decision.results.some((result) => result.teamId === selectedTeamId)) {
      setSelectedTeamId(decision.results[0]?.teamId ?? null);
    }
  }, [decision, selectedTeamId]);

  // j/k and arrows move the cursor; Enter opens its profiles. Dialogs own their keys.
  useEffect(() => {
    const ids = decision?.results.map((result) => result.teamId) ?? [];
    const onKey = (event: KeyboardEvent) => {
      if (ids.length === 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (shortcutBlocked(event.target)) return;
      const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        scrollToSelection.current = true;
        setSelectedTeamId((current) => {
          const index = current ? ids.indexOf(current) : -1;
          return ids[Math.max(0, Math.min(ids.length - 1, index + step))] ?? current;
        });
      } else if (event.key === "Escape") {
        setExpanded(false);
      } else if (
        event.key === "Enter" &&
        !(event.target instanceof HTMLElement && event.target.closest("button, a, summary"))
      ) {
        setProfileTeamId(selectedTeamId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decision, selectedTeamId]);

  useEffect(() => {
    if (!scrollToSelection.current || !selectedTeamId) return;
    scrollToSelection.current = false;
    rowRefs.current.get(selectedTeamId)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedTeamId]);

  const saveRun = useMutation({
    mutationFn: () => {
      if (!eventId || !rankingParams) throw new Error("Shortlist parameters are not loaded");
      return saveOrganizerShortlistRun(eventId, {
        name: runName,
        params: rankingParams,
        selection: {
          capacity,
          waitlistSize: waitlist,
          quotas: shortlist.data?.event.quotas ?? [],
          overrides,
        },
      });
    },
    onSuccess: async (run) => {
      setActiveRunId(run.id);
      setRunName(`Run ${(shortlist.data?.runs.length ?? 0) + 2}`);
      post(`Saved ${run.name}`);
      await queryClient.invalidateQueries({ queryKey: ["organizer-shortlist", eventId] });
    },
  });
  const publishRun = useMutation({
    mutationFn: () => {
      if (!eventId || !activeRunId) throw new Error("Save a shortlist run before publishing");
      return publishOrganizerShortlistRun(eventId, activeRunId);
    },
    onSuccess: async (run) => {
      setPublishConfirmOpen(false);
      post(`Published ${run.name}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizer-shortlist", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-event", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-events"] }),
      ]);
    },
  });

  const displayedResults = useMemo(() => {
    if (!decision) return [];
    if (!blindEvaluation) return decision.results;
    return decision.results.map((res) => redactTeamForBlindReview(res, eventId));
  }, [blindEvaluation, decision, eventId]);

  const selectedResult = displayedResults.find((result) => result.teamId === selectedTeamId);
  const selectedOverride = overrides.find((override) => override.teamId === selectedTeamId);
  const expandedTeamId = expanded ? selectedTeamId : null;
  const activeRun = shortlist.data?.runs.find((run) => run.id === activeRunId);
  const selectedCount = displayedResults.filter((result) => result.status === "selected").length;
  const lastSelected = displayedResults.findLastIndex((result) => result.status === "selected");
  const cutoff =
    decision?.cutoffScore != null
      ? {
          score: decision.cutoffScore,
          rank: lastSelected !== undefined ? (displayedResults[lastSelected]?.rank ?? null) : null,
        }
      : null;

  // Re-ranks once per slider move, so only while an inspector row is open.
  const whatIf = useMemo(() => {
    if (!expanded || !shortlist.data || !rankingParams || !selectedResult) return null;
    const costliest = [...selectedResult.breakdown].sort(
      (left, right) => right.fitPointsLost - left.fitPointsLost,
    )[0];
    if (!costliest || costliest.fitPointsLost < 0.05) return null;
    return {
      skill: costliest.skill,
      rank: whatIfRank(
        shortlist.data.profiles,
        shortlist.data.rankingTeams,
        rankingParams,
        selectedResult.teamId,
        costliest.skill,
      ),
    };
  }, [expanded, rankingParams, selectedResult, shortlist.data]);

  const setRequirement = (skill: string, field: "target" | "weight", value: number) => {
    setRequirements((current) =>
      current.map((requirement) =>
        requirement.skill === skill ? { ...requirement, [field]: value } : requirement,
      ),
    );
  };
  const toggleRow = (teamId: string) => {
    if (teamId === expandedTeamId) {
      setExpanded(false);
      return;
    }
    setSelectedTeamId(teamId);
    setExpanded(true);
  };
  const addOverride = (action: SelectionOverride["action"]) => {
    if (!selectedTeamId || overrideReason.trim().length < 3) return;
    setOverrides((current) => [
      ...current.filter((override) => override.teamId !== selectedTeamId),
      { teamId: selectedTeamId, action, reason: overrideReason.trim() },
    ]);
    setOverrideReason("");
    post(`${selectedResult?.name ?? "Team"} ${actionWords[action]}`);
  };
  const clearOverride = () => {
    setOverrides((current) => current.filter((override) => override.teamId !== selectedTeamId));
    post("Override cleared");
  };

  if (shortlist.isPending) return <LoadingState label="loading shortlist workspace" />;
  if (shortlist.isError) {
    return (
      <Pane title="shortlist">
        <EmptyState
          title="Shortlist unavailable"
          action={<ActionLink to={`/organizer/events/${eventId}`}>Back to event</ActionLink>}
        >
          {shortlist.error.message}
        </EmptyState>
      </Pane>
    );
  }

  const data = shortlist.data;
  // Drafts are saved step by step, so an event can reach this screen with no requirements yet.
  if (data.event.ranking.requirements.length === 0) {
    return (
      <Pane title="shortlist">
        <EmptyState
          title="Add requirements first"
          action={
            <ActionLink to={`/organizer/events/${eventId}/requirements`}>
              Open requirements
            </ActionLink>
          }
        />
      </Pane>
    );
  }
  const profileById = new Map(data.profiles.map((profile) => [profile.personId, profile]));
  const profileTeam = data.teams.find((team) => team.teamId === profileTeamId);
  const unmapped =
    data.event.quotas.some((quota) => quota.attribute === "college") &&
    data.unmappedColleges.length > 0;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      <ScreenHead
        title="Shortlist"
        actions={
          <>
            <ActionButton
              {...(blindEvaluation ? { tone: "primary" as const } : {})}
              title="Toggle Blind Evaluation: anonymizes team and candidate names to prevent unconscious bias"
              onClick={() => setBlindEvaluation((prev) => !prev)}
            >
              Blind: {blindEvaluation ? "ON" : "OFF"}
            </ActionButton>
            <ActionButton
              title="Open Simulation Lab: live what-if projections on capacity, cutoff shifts and candidate pool dynamics"
              onClick={() => setSimLabOpen(true)}
            >
              Simulate
            </ActionButton>
            <ActionButton
              disabled={data.runs.length < 2}
              title={
                data.runs.length < 2
                  ? "Save at least two runs to compare them side-by-side"
                  : "Compare two saved runs side-by-side"
              }
              onClick={() => setComparingRuns(true)}
            >
              Compare runs{data.runs.length < 2 ? ` (${data.runs.length}/2 saved)` : ""}
            </ActionButton>
            {activeRunId ? (
              <ActionAnchor
                href={`/api/organizer/events/${eventId}/shortlist/runs/${activeRunId}.csv`}
              >
                Export CSV
              </ActionAnchor>
            ) : null}
            <ActionButton
              disabled={!decision?.results.length || saveRun.isPending || runName.trim().length < 2}
              onClick={() => saveRun.mutate()}
            >
              {saveRun.isPending ? "Saving…" : "Save run"}
            </ActionButton>
            <ActionButton
              tone="primary"
              disabled={!activeRunId || activeRun?.published || publishRun.isPending}
              title={
                !activeRunId
                  ? "Save a run first before publishing"
                  : activeRun?.published
                    ? "This run is already published"
                    : "Publish final shortlist and announce decisions to participants"
              }
              onClick={() => setPublishConfirmOpen(true)}
            >
              {activeRun?.published
                ? "Published"
                : publishRun.isPending
                  ? "Publishing…"
                  : "Publish"}
            </ActionButton>
          </>
        }
      >
        {data.event.name}
      </ScreenHead>

      {saveRun.isError || publishRun.isError ? (
        <Notice tone="error" tag="error">
          {(saveRun.error ?? publishRun.error)?.message}
        </Notice>
      ) : null}

      {pipeline.error || decision?.quotaReports.length || unmapped ? (
        <div className="grid gap-1">
          {pipeline.error ? (
            <Notice tone="error" tag="cannot rank">
              {pipeline.error}
            </Notice>
          ) : null}
          {decision ? <QuotaLine reports={decision.quotaReports} swaps={decision.swaps} /> : null}
          {unmapped ? (
            <p className="flex items-baseline gap-[1ch] text-warn">
              <span className="min-w-0 truncate" title={data.unmappedColleges.join(", ")}>
                ~ unmapped: {data.unmappedColleges.join(", ")}
              </span>
              <Link className="tui-link shrink-0" to={`/organizer/events/${eventId}/requirements`}>
                map aliases
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      <ProfileReadiness teams={data.teams} />

      {eventId ? <FailedProfiles eventId={eventId} /> : null}

      {/* ------------------------------------------------------ saved runs */}
      {data.runs.length > 0 ? (
        <Pane
          title={`saved runs (${data.runs.length})`}
          meta={activeRunId ? `active: ${activeRun?.name ?? "saved run"}` : "select a run to load"}
          flush
        >
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.runs.map((run) => {
              const isActive = activeRunId === run.id;
              return (
                <div
                  key={run.id}
                  className={`flex flex-col justify-between border p-3 transition-colors ${
                    isActive
                      ? "border-primary bg-primary/10 shadow-sm"
                      : "border-dim/40 bg-bg/50 hover:border-dim"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="truncate font-semibold text-sm text-text">{run.name}</h4>
                      <p className="text-xs text-dim">
                        {run.selectedSeats} seats ·{" "}
                        {run.createdAt ? new Date(run.createdAt).toLocaleDateString() : ""}
                      </p>
                    </div>
                    {run.published ? (
                      <StateTag state="published" />
                    ) : isActive ? (
                      <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                        Active
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-dim/30 pt-2 text-xs">
                    <ActionButton
                      {...(isActive ? { tone: "primary" as const } : {})}
                      title="Load this run's parameters into the workspace"
                      onClick={() => loadSavedRun(run)}
                    >
                      {isActive ? "✓ Active in workspace" : "Load run"}
                    </ActionButton>
                    <ActionLink
                      to={`/organizer/events/${eventId}/runs/${run.id}`}
                      title="Open full view of this saved run"
                    >
                      View ›
                    </ActionLink>
                  </div>
                </div>
              );
            })}
          </div>
        </Pane>
      ) : null}

      {/* ------------------------------------------------------ simulation banner */}
      {isSimulated ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-text">
          <div className="flex items-center gap-2">
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
              Simulation Active
            </span>
            <span className="text-dim">
              Parameters modified. Rank column shows changes (↑ / ↓) compared to baseline event
              parameters.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ActionButton
              onClick={resetToDefaults}
              title="Revert all parameters back to official event defaults"
            >
              Reset to defaults
            </ActionButton>
            <ActionButton
              tone="primary"
              onClick={() => saveRun.mutate()}
              disabled={saveRun.isPending || runName.trim().length < 2}
            >
              {saveRun.isPending ? "Saving…" : "Save as run"}
            </ActionButton>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------ ranked teams */}
      <Pane
        title="ranked teams"
        meta={
          <>
            {decision?.results.length ?? 0} teams
            <span className="max-lg:hidden"> · j/k ↵ esc</span>
          </>
        }
        foot={
          decision
            ? `cutoff ${decision.cutoffScore?.toFixed(1) ?? "—"} · ${selectedCount} teams · ${decision.selectedSeats}/${capacity} seats`
            : undefined
        }
        flush
        active
      >
        {decision?.results.length ? (
          <div className="table-scroll">
            <table className="tui-table cards min-[721px]:[&_td]:px-3 min-[721px]:[&_th]:px-3 min-[721px]:[&_tr>*:first-child]:pl-6 min-[721px]:[&_tr>*:last-child]:pr-6">
              <caption className="sr-only">
                Ranked teams. Use j and k to move, Enter to view profiles, Escape to close.
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="num w-[4ch]">
                    #
                  </th>
                  <th scope="col" className="w-full">
                    team
                  </th>
                  <th scope="col" className="num">
                    fit
                  </th>
                  <th scope="col" className="num">
                    score
                  </th>
                  <th scope="col">state</th>
                </tr>
              </thead>
              <tbody>
                {displayedResults.map((result, index) => {
                  const open = expandedTeamId === result.teamId;
                  const team = data.teams.find((item) => item.teamId === result.teamId);
                  const teamFlags = Array.from(
                    new Set(
                      team?.members.flatMap((m) => [
                        ...m.flags,
                        ...(profileById.get(m.personId)?.flags ?? []),
                      ]) ?? [],
                    ),
                  );
                  const baseRank = baselineRanks.get(result.teamId);
                  const delta = baseRank && result.rank ? baseRank - result.rank : 0;
                  return (
                    <Fragment key={result.teamId}>
                      <tr
                        ref={(node) => {
                          if (node) rowRefs.current.set(result.teamId, node);
                          else rowRefs.current.delete(result.teamId);
                        }}
                        data-clickable
                        aria-selected={selectedTeamId === result.teamId}
                        onClick={() => setProfileTeamId(result.teamId)}
                      >
                        <td data-label="rank" className="num dim whitespace-nowrap">
                          <span className="font-semibold text-text">{result.rank ?? "—"}</span>
                          {isSimulated && baseRank && result.rank ? (
                            delta > 0 ? (
                              <span
                                className="ml-1.5 inline-flex items-center text-[11px] font-semibold text-emerald-400"
                                title={`Moved up ${delta} ${delta === 1 ? "rank" : "ranks"} from baseline rank #${baseRank}`}
                              >
                                ↑{delta}
                              </span>
                            ) : delta < 0 ? (
                              <span
                                className="ml-1.5 inline-flex items-center text-[11px] font-semibold text-rose-400"
                                title={`Dropped ${Math.abs(delta)} ${Math.abs(delta) === 1 ? "rank" : "ranks"} from baseline rank #${baseRank}`}
                              >
                                ↓{Math.abs(delta)}
                              </span>
                            ) : (
                              <span
                                className="ml-1.5 inline-flex items-center text-[10px] text-dim"
                                title="Unchanged from baseline rank"
                              >
                                =
                              </span>
                            )
                          ) : null}
                        </td>
                        <td data-label="team">
                          <span className="flex flex-wrap items-baseline justify-end gap-x-[1ch] sm:justify-start">
                            <button
                              type="button"
                              className="tui-link text-left font-bold"
                              aria-haspopup="dialog"
                              onClick={(event) => {
                                event.stopPropagation();
                                setProfileTeamId(result.teamId);
                              }}
                            >
                              {result.name}
                            </button>
                            <TextAction
                              aria-label={`Explain ${result.name}`}
                              aria-expanded={open}
                              aria-controls={open ? `inspect-${result.teamId}` : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleRow(result.teamId);
                              }}
                            >
                              explain
                            </TextAction>
                            <TeamTags result={result} flags={teamFlags} />
                          </span>
                        </td>
                        <td data-label="fit" className="num">
                          {Math.round(result.fit * 100)}%
                        </td>
                        <td data-label="score" className="num font-bold">
                          {result.score.toFixed(1)}
                        </td>
                        <td data-label="state">
                          <DecisionTag result={result} />
                        </td>
                      </tr>
                      {open && selectedResult && team ? (
                        <tr id={`inspect-${result.teamId}`} className="bg-raised">
                          <td
                            colSpan={tableColumns}
                            className="border-b border-line shadow-[inset_2px_0_0_var(--color-accent)] !whitespace-normal min-[721px]:!px-6 !py-6"
                          >
                            <Inspector
                              key={result.teamId}
                              result={selectedResult}
                              team={team}
                              profileById={profileById}
                              seats={team.memberIds.length}
                              cutoff={cutoff}
                              noveltyWeight={novelty}
                              whatIf={whatIf}
                              overrideReason={overrideReason}
                              onReason={setOverrideReason}
                              onOverride={addOverride}
                              onClear={selectedOverride ? clearOverride : undefined}
                              blindEvaluation={blindEvaluation}
                              eventId={eventId}
                            />
                          </td>
                        </tr>
                      ) : null}
                      {index === lastSelected &&
                      index < decision.results.length - 1 &&
                      decision.cutoffScore !== null ? (
                        <CutoffRow score={decision.cutoffScore} columns={tableColumns} />
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : pipeline.error ? null : (
          <div className="px-6">
            <EmptyState title="No submitted teams yet" />
          </div>
        )}
      </Pane>

      {comparingRuns && eventId && data.runs.length >= 2 ? (
        <CompareRunsModal
          eventId={eventId}
          runs={data.runs}
          onClose={() => setComparingRuns(false)}
        />
      ) : null}

      {simLabOpen && decision ? (
        <SimulationLabModal
          tune={
            <Pane title="tune" meta="live">
              <div className="grid gap-5">
                <Prompt
                  {...user}
                  command={`talentradar rank --alpha ${alpha.toFixed(2)} --novelty ${novelty} --min-fit ${Math.round(minFit * 100)}% --seats ${capacity} --weight ${requirements.map((requirement) => `${requirement.skill}=${requirement.weight}`).join(",")}${overrides.length ? ` --overrides ${overrides.length}` : ""}`}
                />
                <SkillGroups
                  items={requirements}
                  idOf={(requirement) => requirement.skill}
                  className={sliderGrid}
                  labelled
                >
                  {(requirement) => (
                    <Slider
                      compact
                      key={requirement.skill}
                      label={skillLabel(requirement.skill)}
                      value={requirement.weight}
                      min={0}
                      max={5}
                      step={1}
                      onChange={(value) => setRequirement(requirement.skill, "weight", value)}
                      format={(value) => `×${value}`}
                    />
                  )}
                </SkillGroups>
                <section className="grid gap-2" aria-label="ranking">
                  <h3 className="dim text-sm font-normal">ranking</h3>
                  <div className={sliderGrid}>
                    <Slider
                      compact
                      label="alpha"
                      value={alpha}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={setAlpha}
                      format={(value) => value.toFixed(2)}
                      hint="1 coverage · 0 depth"
                    />
                    <Slider
                      compact
                      label="novelty"
                      value={novelty}
                      min={0}
                      max={25}
                      step={1}
                      onChange={setNovelty}
                      format={(value) => String(value)}
                    />
                    <Slider
                      compact
                      label="min fit"
                      value={minFit}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={setMinFit}
                      format={(value) => `${Math.round(value * 100)}%`}
                    />
                  </div>
                </section>

                <Details summary="more settings">
                  <div className="grid gap-8 pt-2">
                    <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                      <Field label="run name" required>
                        <TextInput
                          value={runName}
                          maxLength={100}
                          onChange={(event) => setRunName(event.target.value)}
                        />
                      </Field>
                      <Field label="capacity" hint="participants" required>
                        <TextInput
                          type="number"
                          min="1"
                          max="5000"
                          value={capacity}
                          onChange={(event) => setCapacity(Number(event.target.value))}
                        />
                      </Field>
                      <Field label="waitlist" hint="teams">
                        <TextInput
                          type="number"
                          min="0"
                          max="500"
                          value={waitlist}
                          onChange={(event) => setWaitlist(Number(event.target.value))}
                        />
                      </Field>
                    </div>
                    <Group
                      title="targets"
                      action={
                        <Link
                          className="tui-link text-xs"
                          to={`/organizer/events/${eventId}/requirements`}
                        >
                          edit list
                        </Link>
                      }
                    >
                      <SkillGroups
                        items={requirements}
                        idOf={(requirement) => requirement.skill}
                        className={sliderGrid}
                      >
                        {(requirement) => (
                          <Slider
                            compact
                            key={requirement.skill}
                            label={skillLabel(requirement.skill)}
                            value={requirement.target}
                            min={1}
                            max={5}
                            step={0.5}
                            onChange={(value) => setRequirement(requirement.skill, "target", value)}
                            format={(value) => value.toFixed(1)}
                          />
                        )}
                      </SkillGroups>
                    </Group>
                    <Group title="confidence factors">
                      <div className="grid grid-cols-3 gap-4 sm:max-w-md">
                        {(["high", "medium", "low"] as const).map((level) => (
                          <Field label={level} key={level}>
                            <TextInput
                              type="number"
                              min="0"
                              max="1"
                              step="0.05"
                              value={confidenceFactors[level]}
                              onChange={(event) =>
                                setConfidenceFactors((current) => ({
                                  ...current,
                                  [level]: Number(event.target.value),
                                }))
                              }
                            />
                          </Field>
                        ))}
                      </div>
                    </Group>
                    {data.runs.length > 0 ? (
                      <Group title={`saved runs (${data.runs.length})`}>
                        <div className="tui-list -mx-4 sm:max-w-xl">
                          {data.runs.map((run) => (
                            <Link
                              key={run.id}
                              to={`/organizer/events/${eventId}/runs/${run.id}`}
                              aria-current={activeRunId === run.id ? "true" : undefined}
                            >
                              <span className="marker" aria-hidden="true">
                                ›
                              </span>
                              <span className="min-w-0 truncate">{run.name}</span>
                              {run.published ? (
                                <StateTag state="published" />
                              ) : (
                                <span className="dim text-xs">{run.selectedSeats} seats</span>
                              )}
                            </Link>
                          ))}
                        </div>
                      </Group>
                    ) : null}
                  </div>
                </Details>
              </div>
            </Pane>
          }
          preview={
            <div className="border border-dim/40 bg-bg/50 p-3">
              <div className="flex items-center justify-between text-xs text-dim">
                <span className="font-semibold uppercase text-text">Live Preview</span>
                <span>
                  Cutoff:{" "}
                  <strong className="text-text">{decision.cutoffScore?.toFixed(1) ?? "—"}</strong> ·
                  Selected: <strong className="text-text">{selectedCount} teams</strong> (
                  {decision.selectedSeats}/{capacity} seats)
                </span>
              </div>
              <div className="mt-2 divide-y divide-dim/20 text-xs">
                {displayedResults.slice(0, 5).map((r) => {
                  const baseRank = baselineRanks.get(r.teamId);
                  const delta = baseRank && r.rank ? baseRank - r.rank : 0;
                  return (
                    <div key={r.teamId} className="flex items-center justify-between py-1">
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="font-mono text-dim">#{r.rank}</span>
                        <span className="truncate font-medium text-text">{r.name}</span>
                        {delta > 0 ? (
                          <span className="text-[10px] font-semibold text-emerald-400">
                            ↑{delta}
                          </span>
                        ) : delta < 0 ? (
                          <span className="text-[10px] font-semibold text-rose-400">
                            ↓{Math.abs(delta)}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-dim">{r.score.toFixed(1)} pts</span>
                    </div>
                  );
                })}
              </div>
            </div>
          }
          runName={runName}
          onRunName={setRunName}
          saving={saveRun.isPending}
          saveError={saveRun.isError ? saveRun.error.message : null}
          savedCount={data.runs.length}
          onSave={() => saveRun.mutate()}
          onCompare={() => {
            setSimLabOpen(false);
            setComparingRuns(true);
          }}
          onClose={() => setSimLabOpen(false)}
        />
      ) : null}

      {publishConfirmOpen && activeRun ? (
        <PublishConfirmModal
          runName={activeRun.name}
          registrationClosesAt={data.event.timeline?.registrationClosesAt}
          isPending={publishRun.isPending}
          error={publishRun.isError ? publishRun.error.message : null}
          onConfirm={() => publishRun.mutate()}
          onClose={() => setPublishConfirmOpen(false)}
        />
      ) : null}

      {eventId && profileTeam ? (
        <ProfileModal
          key={profileTeam.teamId}
          eventId={eventId}
          title={`${profileTeam.name} · profiles`}
          members={profileTeam.members}
          onClose={() => setProfileTeamId(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * A person whose profile is not "ready" has no skills to score, so their team shows 0 fit and 0
 * points. That means "not assessed yet", not "weak", so say so instead of leaving a wall of zeros.
 */
function ProfileReadiness({ teams }: { teams: OrganizerShortlistTeam[] }) {
  const members = teams.flatMap((team) => team.members);
  const waiting = members.filter((member) => member.profileStatus !== "ready");
  if (waiting.length === 0) return null;
  const count = (status: string) =>
    waiting.filter((member) => member.profileStatus === status).length;
  const parts = (["pending", "building", "failed"] as const)
    .filter((status) => count(status) > 0)
    .map((status) => `${count(status)} ${status}`);
  const stalled = count("pending") + count("building") === waiting.length;
  return (
    <Notice tone="warn" tag="profiles">
      {waiting.length} of {members.length} people have no finished profile ({parts.join(", ")}).
      Their teams score 0 because nothing has been assessed yet, not because they are weak.
      {stalled
        ? " If these never change, the background worker is not running or has no Gemini key: start the API with RUN_WORKER_IN_API=true and GEMINI_API_KEY set."
        : null}
    </Notice>
  );
}

/** One warn line when profile builds failed; opens to the errors with a retry per person. */
function FailedProfiles({ eventId }: { eventId: string }) {
  const queryClient = useQueryClient();
  const { post } = useStatusLine();
  const failures = useQuery({
    queryKey: ["profile-failures", eventId],
    queryFn: () => getProfileFailures(eventId),
    retry: false,
  });
  const retry = useMutation({
    mutationFn: (profileId: string) => retryProfileFailure(eventId, profileId),
    onSuccess: async () => {
      post("Retry queued");
      await queryClient.invalidateQueries({ queryKey: ["profile-failures", eventId] });
    },
  });
  const count = failures.data?.length ?? 0;
  if (count === 0) return null;
  return (
    <div className="[&_summary]:text-warn">
      <Details summary={`~ ${count} profile${count === 1 ? "" : "s"} failed`} meta="· view">
        <ul className="grid max-w-3xl gap-3">
          {failures.data?.map((failure) => (
            <li className="flex items-baseline justify-between gap-4" key={failure.profileId}>
              <span className="grid min-w-0">
                <span className="flex items-center gap-x-[1ch]">
                  {failure.github ? <Avatar login={failure.github} size={20} /> : null}
                  {failure.name}
                  {failure.github ? <span className="dim text-xs">@{failure.github}</span> : null}
                </span>
                <span className="dim truncate text-xs" title={failure.error}>
                  {failure.error}
                </span>
              </span>
              <TextAction
                disabled={retry.isPending}
                onClick={() => retry.mutate(failure.profileId)}
                aria-label={`Retry ${failure.name}`}
              >
                retry
              </TextAction>
            </li>
          ))}
        </ul>
        {retry.isError ? (
          <Notice tone="error" tag="error">
            {retry.error.message}
          </Notice>
        ) : null}
      </Details>
    </div>
  );
}

/** The expanded row under a team: why it scored what it did, and the override. */
function Inspector({
  result,
  team,
  profileById,
  seats,
  cutoff,
  noveltyWeight,
  whatIf,
  overrideReason,
  onReason,
  onOverride,
  onClear,
  blindEvaluation,
  eventId,
}: {
  result: DecidedTeam;
  team: OrganizerShortlistTeam;
  profileById: ReadonlyMap<string, PersonProfile>;
  seats: number;
  cutoff: { score: number; rank: number | null } | null;
  noveltyWeight: number;
  whatIf: { skill: string; rank: number | null } | null;
  overrideReason: string;
  onReason: (reason: string) => void;
  onOverride: (action: SelectionOverride["action"]) => void;
  onClear: (() => void) | undefined;
  blindEvaluation?: boolean | undefined;
  eventId?: string | undefined;
}) {
  const memberName = (personId: string | null) => {
    if (!personId) return "";
    if (blindEvaluation) return pseudonymizePersonName(personId);
    return team.members.find((member) => member.personId === personId)?.name ?? personId;
  };
  const noveltySource = team.memberIds
    .map((personId) => ({ personId, novelty: profileById.get(personId)?.novelty ?? 0 }))
    .sort((left, right) => right.novelty - left.novelty)[0];
  const evidence = team.memberIds.flatMap((personId) => {
    const profile = profileById.get(personId);
    if (!profile) return [];
    return profile.skills
      .slice(0, 3)
      .flatMap((skill) => skill.evidence.slice(0, 2).map((item) => ({ profile, skill, item })));
  });
  const reasonReady = overrideReason.trim().length >= 3;

  return (
    <div className="grid w-full gap-6 text-left">
      <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
        <header className="flex items-center gap-5 md:col-span-2">
          <span className="font-display text-5xl leading-none text-accent">
            <span className="sr-only">score </span>
            {result.score.toFixed(1)}
          </span>
          <span className="grid gap-1">
            <span>{decisionSentence(result, seats, cutoff)}</span>
            {result.borderline ? (
              <span className="text-warn">~ Borderline. Check evidence.</span>
            ) : null}
          </span>
        </header>

        <SkillGroups
          items={result.breakdown}
          idOf={(item) => item.skill}
          className="grid max-w-md content-start gap-3"
        >
          {(item) => {
            const under = item.teamLevel < item.target;
            return (
              <div
                className="grid gap-1"
                key={item.skill}
                title={item.bestMemberId ? `best: ${memberName(item.bestMemberId)}` : undefined}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className={item.weight === 0 ? "dim line-through" : undefined}>
                    {skillLabel(item.skill)}
                    <span className="dim"> ×{item.weight}</span>
                  </span>
                  {item.fitPointsLost >= 0.05 ? (
                    <span className="text-warn tabular-nums">−{item.fitPointsLost.toFixed(1)}</span>
                  ) : null}
                </span>
                <Bar
                  value={item.teamLevel}
                  target={item.target}
                  label={skillLabel(item.skill)}
                  {...(under ? { tone: "warn" as const } : {})}
                />
                {item.bestMemberId ? null : <span className="dim text-xs">no evidence</span>}
              </div>
            );
          }}
        </SkillGroups>

        <section className="grid content-start gap-3" aria-label="Novelty and what-if">
          {result.novelty > 0 && noveltySource ? (
            <p>
              <span className="text-accent">+{(result.novelty * noveltyWeight).toFixed(1)}</span>{" "}
              novelty from {memberName(noveltySource.personId)}
              {noveltyWords[String(result.novelty)] ? (
                <span className="dim"> ({noveltyWords[String(result.novelty)]})</span>
              ) : null}
            </p>
          ) : (
            <p className="dim">No novelty bonus.</p>
          )}
          {whatIf ? (
            <p className="border-l-2 border-info pl-2">
              <span className="text-info">What-if:</span> {skillLabel(whatIf.skill)} ×0 →{" "}
              {whatIf.rank === null
                ? "ineligible"
                : whatIf.rank === result.rank
                  ? `still #${whatIf.rank}`
                  : `#${whatIf.rank}`}
            </p>
          ) : null}
        </section>
      </div>

      <div className="grid gap-3 border-t border-line pt-4">
        <Details summary="members" meta={team.members.length}>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {team.members.map((member) => {
              const profile = profileById.get(member.personId);
              const flags = [...new Set([...member.flags, ...(profile?.flags ?? [])])];
              const displayName = blindEvaluation
                ? pseudonymizePersonName(member.personId)
                : member.name;
              return (
                <li className="grid content-start" key={member.personId}>
                  <span className="flex flex-wrap items-center gap-x-[1ch]">
                    {blindEvaluation ? (
                      <span className="inline-block h-6 w-6 rounded-full bg-dim/20 text-center text-xs font-bold leading-6">
                        ?
                      </span>
                    ) : (
                      <Avatar login={member.github} size={24} />
                    )}
                    <span className="font-bold">{displayName}</span>
                    {blindEvaluation ? null : <span className="dim text-xs">@{member.github}</span>}
                    {member.profileStatus === "ready" ? null : (
                      <StateTag
                        state={member.profileStatus}
                        label={`profile ${member.profileStatus}`}
                      />
                    )}
                  </span>
                  <span className="dim text-xs">
                    {blindEvaluation ? "[College Redacted]" : (member.college ?? "No college")}
                  </span>
                  {profile?.summary ? (
                    <p className="mt-1 text-sm">
                      {blindEvaluation
                        ? "[Profile summary hidden in Blind Evaluation mode]"
                        : profile.summary}
                    </p>
                  ) : null}
                  {flags.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-x-[1ch] gap-y-1">
                      {flags.map((flag) => {
                        const meta = reviewFlagLabels[flag];
                        return (
                          <Status tone="warn" key={flag} title={meta?.description}>
                            {meta?.label ?? flag.replaceAll("_", " ")}
                          </Status>
                        );
                      })}
                    </span>
                  ) : null}
                  {profile?.skills.some((s) => s.evidence.length === 0) ? (
                    <span className="mt-1 flex flex-wrap gap-x-[1ch]">
                      <Status
                        tone="warn"
                        title="Candidate claims skills on their CV for which no repository evidence was found"
                      >
                        Unverified CV claim
                      </Status>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Details>

        <Details summary="evidence" meta={evidence.length}>
          {evidence.length === 0 ? (
            <p className="dim">
              {team.members.some((member) => member.profileStatus !== "ready")
                ? `No finished profile for ${team.members.filter((member) => member.profileStatus !== "ready").length} of ${team.members.length} members yet, so there is nothing to cite.`
                : "These profiles come from CV claims only: no repository code was analysed, so there are no files to cite. Add GitHub accounts to get code evidence."}
            </p>
          ) : (
            <div className="tui-list -mx-4 md:grid-cols-2">
              {evidence.map(({ profile, skill, item }) => (
                <a
                  href={evidenceUrl(item)}
                  key={`${profile.personId}-${skill.id}-${item.repository}-${item.path}`}
                  rel="noreferrer"
                  target="_blank"
                  title={item.note}
                >
                  <span className="marker" aria-hidden="true">
                    ↗
                  </span>
                  <span className="col-span-2 grid min-w-0">
                    <span className="truncate">{item.path}</span>
                    <span className="dim truncate text-xs">
                      {profile.displayName.split(" ")[0]} · {skillLabel(skill.id)} ·{" "}
                      {item.commitSha.slice(0, 8)}
                    </span>
                  </span>
                </a>
              ))}
            </div>
          )}
        </Details>

        {eventId ? (
          <TeamGapFillersSection
            eventId={eventId}
            teamId={result.teamId}
            blindEvaluation={blindEvaluation}
          />
        ) : null}

        <Details
          summary="override"
          meta={result.override ? actionWords[result.override.action] : undefined}
          open={Boolean(result.override)}
        >
          <div className="grid max-w-xl gap-4">
            {result.override ? (
              <p>
                <Status tone="info">{actionWords[result.override.action]}</Status>{" "}
                {result.override.reason}
              </p>
            ) : null}
            <Field label="reason" hint="Logged with the run" required>
              <TextInput
                value={overrideReason}
                maxLength={500}
                onChange={(event) => onReason(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton disabled={!reasonReady} onClick={() => onOverride("pin_in")}>
                Pin in
              </ActionButton>
              <ActionButton
                tone="danger"
                disabled={!reasonReady}
                onClick={() => onOverride("pin_out")}
              >
                Pin out
              </ActionButton>
              {onClear ? <TextAction onClick={onClear}>clear</TextAction> : null}
            </div>
          </div>
        </Details>
      </div>
    </div>
  );
}

/** C3: Team Gap-Filler component showing missing skill deltas and top candidate suggestions */
function TeamGapFillersSection({
  eventId,
  teamId,
  blindEvaluation,
}: {
  eventId: string;
  teamId: string;
  blindEvaluation?: boolean | undefined;
}) {
  const query = useQuery({
    queryKey: ["organizer-team-gap-fillers", eventId, teamId],
    queryFn: () => getTeamGapFillers(eventId, teamId),
    retry: false,
  });

  if (query.isPending) return null;
  if (!query.data) return null;

  const { unmetRequirements, suggestedCandidates } = query.data;
  if (unmetRequirements.length === 0 && suggestedCandidates.length === 0) return null;

  return (
    <Details
      summary="gap-filler suggestions"
      meta={
        suggestedCandidates.length > 0
          ? `${suggestedCandidates.length} candidate${suggestedCandidates.length === 1 ? "" : "s"}`
          : undefined
      }
    >
      <div className="grid gap-3">
        {unmetRequirements.length > 0 ? (
          <p className="text-warn text-xs">
            ~ Missing / Under target:{" "}
            {unmetRequirements
              .map((u) => `${skillLabel(u.skill)} (deficit −${u.deficit.toFixed(1)})`)
              .join(", ")}
          </p>
        ) : (
          <p className="text-accent text-xs">✓ All requirement targets covered</p>
        )}

        {suggestedCandidates.length === 0 ? (
          <p className="dim text-xs">
            No available looking-for-team candidates fill current team gaps.
          </p>
        ) : (
          <ul className="grid gap-2">
            {suggestedCandidates.map(
              ({ candidate, scoreGain, coveredRequirements, newTeamScore }) => {
                const displayName = blindEvaluation
                  ? pseudonymizePersonName(candidate.personId)
                  : candidate.name;
                return (
                  <li
                    key={candidate.personId}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border border-dim/40 p-2 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      {blindEvaluation ? null : candidate.github ? (
                        <Avatar login={candidate.github} size={18} />
                      ) : null}
                      <strong className="font-semibold">{displayName}</strong>
                      {blindEvaluation ? null : candidate.college ? (
                        <span className="dim">({candidate.college})</span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-3">
                      {coveredRequirements.length > 0 ? (
                        <span className="text-accent">
                          + fills {coveredRequirements.map((s) => skillLabel(s)).join(", ")}
                        </span>
                      ) : null}
                      <span className="font-bold text-accent">+{scoreGain.toFixed(1)} pts</span>
                      <span className="dim">(team → {newTeamScore.toFixed(1)})</span>
                    </span>
                  </li>
                );
              },
            )}
          </ul>
        )}
      </div>
    </Details>
  );
}

export function SavedRunPage() {
  const { eventId, runId } = useParams();
  const [profileTeamId, setProfileTeamId] = useState<string | null>(null);
  const run = useQuery({
    queryKey: ["organizer-shortlist-run", eventId, runId],
    queryFn: () => getOrganizerShortlistRun(eventId ?? "", runId ?? ""),
    enabled: Boolean(eventId && runId),
    retry: false,
  });

  if (run.isPending) return <LoadingState label="loading frozen run" />;
  if (run.isError || !run.data) {
    return (
      <Pane title="saved run">
        <EmptyState
          title="Saved run not found"
          action={
            <ActionLink to={`/organizer/events/${eventId}/shortlist`}>Back to workspace</ActionLink>
          }
        >
          {run.error?.message}
        </EmptyState>
      </Pane>
    );
  }

  const data = run.data;
  const profileTeam = data.results.find((team) => team.teamId === profileTeamId);
  const selectedCount = data.results.filter((result) => result.status === "selected").length;
  const waitlistedCount = data.results.filter((result) => result.status === "waitlisted").length;
  const lastSelected = data.results.findLastIndex((result) => result.status === "selected");
  const teamName = (teamId: string) =>
    data.results.find((result) => result.teamId === teamId)?.name ?? teamId;
  const { confidenceFactors } = data.params;
  const changes = data.overrides.length + data.swaps.length;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10">
      <ScreenHead
        title={data.name}
        actions={
          <>
            <ActionLink to={`/organizer/events/${eventId}/shortlist`}>Back to workspace</ActionLink>
            <ActionLink to={`/organizer/events/${eventId}/runs/${data.id}/print`}>Print</ActionLink>
            <ActionAnchor
              tone="primary"
              href={`/api/organizer/events/${eventId}/shortlist/runs/${data.id}.csv`}
            >
              Export CSV
            </ActionAnchor>
          </>
        }
      >
        <span className="flex flex-wrap items-baseline gap-x-[1ch]">
          frozen {formatDateTime(data.createdAt)}
          {data.published ? <StateTag state="published" /> : <StateTag state="draft" />}
        </span>
      </ScreenHead>

      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat value={selectedCount} label={`selected · ${data.selection.selectedSeats} seats`} />
        <Stat value={waitlistedCount} label="waitlist" />
        <Stat value={data.selection.cutoffScore?.toFixed(1) ?? "—"} label="cutoff" />
        <Stat value={data.overrides.length} label="overrides" />
      </div>

      <Pane
        title="results"
        meta={`${data.results.length} teams`}
        foot={`${data.selection.selectedSeats}/${data.selection.capacity} seats`}
        flush
      >
        <div className="table-scroll">
          <table className="tui-table cards min-[721px]:[&_tr>*:first-child]:pl-6 min-[721px]:[&_tr>*:last-child]:pr-6">
            <caption className="sr-only">Frozen shortlist results</caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  #
                </th>
                <th scope="col">team</th>
                <th scope="col" className="num">
                  fit
                </th>
                <th scope="col" className="num max-xl:hidden">
                  depth
                </th>
                <th scope="col" className="num max-xl:hidden">
                  novelty
                </th>
                <th scope="col" className="num">
                  score
                </th>
                <th scope="col">decision</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((result, index) => (
                <SavedRow
                  key={result.teamId}
                  result={result}
                  onProfiles={() => setProfileTeamId(result.teamId)}
                  cutoffAfter={
                    index === lastSelected && index < data.results.length - 1
                      ? data.selection.cutoffScore
                      : null
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </Pane>

      <div className="grid gap-4">
        {eventId && profileTeam ? (
          <ProfileModal
            key={profileTeam.teamId}
            eventId={eventId}
            title={`${profileTeam.name} · profiles`}
            members={profileTeam.memberIds.map((personId) => ({
              personId,
              name:
                data.snapshot?.people.find((person) => person.personId === personId)?.name ??
                "Participant",
            }))}
            frozenPeople={data.snapshot?.people ?? null}
            onClose={() => setProfileTeamId(null)}
          />
        ) : null}

        <Details summary="parameters">
          <div className="grid max-w-2xl gap-6">
            <KeyValue
              items={[
                ["alpha", data.params.alpha.toFixed(2)],
                ["novelty", `${data.params.noveltyWeight} points`],
                ["min fit", `${Math.round(data.params.minFit * 100)}%`],
                ["capacity", `${data.selection.capacity} participants`],
                ["waitlist", `${data.selection.waitlistSize} teams`],
                [
                  "confidence",
                  `high ${confidenceFactors.high} · medium ${confidenceFactors.medium} · low ${confidenceFactors.low}`,
                ],
              ]}
            />
            <SkillGroups items={data.params.requirements} idOf={(requirement) => requirement.skill}>
              {(requirement) => (
                <div
                  className="grid grid-cols-[20ch_minmax(0,1fr)] items-baseline gap-3"
                  key={requirement.skill}
                >
                  <span className={requirement.weight === 0 ? "dim line-through" : undefined}>
                    {skillLabel(requirement.skill)}
                    <span className="dim"> ×{requirement.weight}</span>
                  </span>
                  <Bar
                    value={requirement.target}
                    label={`${skillLabel(requirement.skill)} target`}
                  />
                </div>
              )}
            </SkillGroups>
            <QuotaLine reports={data.quotaReports} swaps={[]} />
          </div>
        </Details>

        <Details summary="audit" meta={changes}>
          {changes === 0 ? (
            <p className="dim">No overrides or swaps.</p>
          ) : (
            <ul className="grid max-w-2xl gap-4">
              {data.overrides.map((override) => (
                <li className="grid gap-1" key={`${override.teamId}-${override.at}`}>
                  <span className="flex flex-wrap items-baseline gap-x-[1ch]">
                    <Status tone="info">{actionWords[override.action]}</Status>
                    <strong>{teamName(override.teamId)}</strong>
                    <span className="dim text-xs">
                      {override.by} ·{" "}
                      <time dateTime={override.at}>{formatDateTime(override.at)}</time>
                    </span>
                  </span>
                  <span>“{override.reason}”</span>
                </li>
              ))}
              {data.swaps.map((swap) => (
                <li className="grid gap-1" key={`${swap.addedTeamId}-${swap.removedTeamId}`}>
                  <span className="flex flex-wrap items-baseline gap-x-[1ch]">
                    <Status tone="warn">quota swap</Status>
                    <StateTag state="selected" label={teamName(swap.addedTeamId)} />
                    <StateTag state="not_selected" label={teamName(swap.removedTeamId)} />
                  </span>
                  <span className="dim">{swap.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Details>
      </div>
    </div>
  );
}

function SavedRow({
  result,
  cutoffAfter,
  onProfiles,
}: {
  result: DecidedTeam;
  cutoffAfter: number | null;
  onProfiles: () => void;
}) {
  return (
    <>
      <tr>
        <td data-label="rank" className="num dim">
          {result.rank ?? "—"}
        </td>
        <th scope="row" data-label="team" className="font-normal">
          <span className="flex flex-wrap items-baseline justify-end gap-x-[1ch] sm:justify-start">
            <button
              type="button"
              className="tui-link font-bold"
              aria-haspopup="dialog"
              onClick={onProfiles}
            >
              {result.name}
            </button>
            <TeamTags result={result} />
          </span>
        </th>
        <td data-label="fit" className="num">
          {Math.round(result.fit * 100)}%
        </td>
        <td data-label="depth" className="num max-xl:hidden">
          {result.depth.toFixed(2)}
        </td>
        <td data-label="novelty" className="num max-xl:hidden">
          {result.novelty.toFixed(2)}
        </td>
        <td data-label="score" className="num font-bold">
          {result.score.toFixed(1)}
        </td>
        <td data-label="decision">
          <DecisionTag result={result} />
        </td>
      </tr>
      {cutoffAfter != null ? <CutoffRow score={cutoffAfter} columns={7} /> : null}
    </>
  );
}

/** The last selected team's score and rank: what every other decision is measured against. */
function runCutoff(run: OrganizerShortlistRun) {
  if (run.selection.cutoffScore == null) return null;
  const last = run.results.findLast((result) => result.status === "selected");
  return { score: run.selection.cutoffScore, rank: last?.rank ?? null };
}

/**
 * The explanation card for one team, built only from the run's frozen snapshot: decision,
 * points lost per requirement, strongest skill with its evidence, novelty and flags.
 */
export function explainTeam(
  result: DecidedTeam,
  run: OrganizerShortlistRun,
  people: ReadonlyMap<string, ShortlistRunPerson>,
): string[] {
  const name = (personId: string | null) => (personId && people.get(personId)?.name) ?? "no member";
  const lines = [decisionSentence(result, result.memberIds.length, runCutoff(run))];
  for (const item of result.breakdown) {
    if (item.fitPointsLost < 0.05) continue;
    lines.push(
      `Lost ${item.fitPointsLost.toFixed(1)} points on ${skillLabel(item.skill)}: ${
        item.bestMemberId
          ? `best ${item.teamLevel.toFixed(1)} (${name(item.bestMemberId)}), target ${item.target}`
          : `no member shows evidence (target ${item.target})`
      }.`,
    );
  }
  const strongest = [...result.breakdown]
    .filter((item) => item.bestMemberId)
    .sort((left, right) => right.teamLevel - left.teamLevel)[0];
  if (strongest?.bestMemberId) {
    const skill = people
      .get(strongest.bestMemberId)
      ?.profile?.skills.find((candidate) => candidate.id === strongest.skill);
    const files = skill?.evidence
      .slice(0, 2)
      .map((item) => `${item.repository}/${item.path}@${item.commitSha.slice(0, 7)}`);
    lines.push(
      `Strongest: ${skillLabel(strongest.skill)} ${strongest.teamLevel.toFixed(1)}, ${name(strongest.bestMemberId)}${files?.length ? `, from ${files.join(", ")}` : ""}.`,
    );
  }
  if (result.novelty > 0) {
    lines.push(`Novelty +${(result.novelty * run.params.noveltyWeight).toFixed(1)}.`);
  }
  for (const personId of result.memberIds) {
    const flags = people.get(personId)?.profile?.flags ?? [];
    if (flags.length) {
      lines.push(
        `Note: ${name(personId)}: ${flags.map((flag) => flag.replaceAll("_", " ")).join(", ")}.`,
      );
    }
  }
  if (result.override) lines.push(`Override reason: “${result.override.reason}”.`);
  return lines;
}

const statusWords: Record<DecidedTeam["status"], string> = {
  selected: "selected",
  waitlisted: "waitlisted",
  not_selected: "not selected",
  ineligible: "ineligible",
};

/** Black-on-white page for the browser's Save as PDF. Rendered outside the terminal frame. */
export function PrintRunPage() {
  const { eventId, runId } = useParams();
  const run = useQuery({
    queryKey: ["organizer-shortlist-run", eventId, runId],
    queryFn: () => getOrganizerShortlistRun(eventId ?? "", runId ?? ""),
    enabled: Boolean(eventId && runId),
    retry: false,
  });

  useEffect(() => {
    if (run.data) document.title = `${run.data.name} — TalentRadar`;
  }, [run.data]);

  const page =
    "min-h-screen bg-white p-8 font-mono text-[13px] leading-normal text-black print:p-0 print:text-[10pt]";
  if (run.isPending) return <main className={page}>Loading run…</main>;
  if (run.isError || !run.data) {
    return (
      <main className={page}>
        <p role="alert">Saved run not found. {run.error?.message}</p>
      </main>
    );
  }

  const data = run.data;
  const people = new Map((data.snapshot?.people ?? []).map((person) => [person.personId, person]));
  const count = (status: DecidedTeam["status"]) =>
    data.results.filter((result) => result.status === status).length;
  const versions = data.snapshot?.versions;

  return (
    <main className={page}>
      <div className="mx-auto grid max-w-4xl gap-6 print:max-w-none">
        <nav className="flex gap-4 print:hidden">
          <Link className="underline" to={`/organizer/events/${eventId}/runs/${data.id}`}>
            Back to run
          </Link>
          <button className="underline" type="button" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
        </nav>

        <header className="grid gap-1 border-b border-black pb-3">
          <h1 className="text-xl font-bold">{data.name}</h1>
          <p>
            {data.published ? "Published final shortlist" : "Draft run"} · frozen{" "}
            {formatDateTime(data.createdAt)}
          </p>
          <p>
            {count("selected")} selected · {data.selection.selectedSeats}/{data.selection.capacity}{" "}
            seats · {count("waitlisted")} waitlisted · cutoff{" "}
            {data.selection.cutoffScore?.toFixed(1) ?? "—"}
          </p>
          <p className="text-[11px]">
            alpha {data.params.alpha.toFixed(2)} · novelty {data.params.noveltyWeight} · min fit{" "}
            {Math.round(data.params.minFit * 100)}% ·{" "}
            {data.params.requirements
              .map(
                (requirement) =>
                  `${skillLabel(requirement.skill)} ×${requirement.weight} → ${requirement.target}`,
              )
              .join(", ")}
            {versions
              ? ` · taxonomy ${versions.taxonomy}${versions.rubric ? ` · rubric ${versions.rubric}` : ""}${versions.prompts.length ? ` · prompt ${versions.prompts.join(", ")}` : ""}`
              : ""}
          </p>
        </header>

        <table className="w-full border-collapse text-left [&_td]:border-b [&_td]:border-black/30 [&_td]:py-1 [&_td]:pr-3 [&_th]:border-b [&_th]:border-black [&_th]:py-1 [&_th]:pr-3">
          <caption className="sr-only">Shortlist results</caption>
          <thead className="print:table-header-group">
            <tr>
              <th scope="col">#</th>
              <th scope="col">team</th>
              <th scope="col">members</th>
              <th scope="col" className="text-right">
                fit
              </th>
              <th scope="col" className="text-right">
                score
              </th>
              <th scope="col">decision</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((result) => (
              <tr className="break-inside-avoid align-top" key={result.teamId}>
                <td>{result.rank ?? "—"}</td>
                <td className="font-bold">{result.name}</td>
                <td>
                  {result.memberIds.map((personId) => people.get(personId)?.name ?? "—").join(", ")}
                </td>
                <td className="text-right">{Math.round(result.fit * 100)}%</td>
                <td className="text-right">{result.score.toFixed(1)}</td>
                <td>
                  {statusWords[result.status]}
                  {result.status === "waitlisted" ? ` #${result.waitlistPosition}` : ""}
                  {result.status === "ineligible" && result.ineligibleReasons[0]
                    ? ` (${result.ineligibleReasons[0].split(":")[0]?.toLowerCase()})`
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="grid gap-4" aria-label="Explanations">
          <h2 className="border-b border-black pb-1 font-bold">Explanations</h2>
          {data.results.map((result) => (
            <article className="grid gap-1 break-inside-avoid" key={result.teamId}>
              <h3 className="font-bold">
                {result.name} — {result.rank ? `#${result.rank} · ` : ""}score{" "}
                {result.score.toFixed(1)} · {statusWords[result.status]}
                {result.status === "waitlisted" ? ` (#${result.waitlistPosition})` : ""}
              </h3>
              <ul className="list-disc pl-5">
                {explainTeam(result, data, people).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
