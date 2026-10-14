import {
  type DecidedTeam,
  type PersonProfile,
  type QuotaReport,
  type QuotaSwap,
  type RankedTeam,
  type RankingParams,
  rank,
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
  type OrganizerShortlistRun,
  type OrganizerShortlistTeam,
  publishOrganizerShortlistRun,
  retryProfileFailure,
  type ShortlistRunPerson,
  saveOrganizerShortlistRun,
} from "../lib/api";
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

function TeamTags({ result }: { result: DecidedTeam }) {
  const reason = result.status === "ineligible" ? result.ineligibleReasons[0] : undefined;
  if (!result.borderline && !result.quotaSwap && !result.override && !reason) return null;
  return (
    <span className="flex flex-wrap gap-x-[1ch] text-xs">
      {reason ? <span className="dim">{reason.split(":")[0]}</span> : null}
      {result.borderline ? <Status tone="warn">review</Status> : null}
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
  // The cursor row, and whether its inspector row is open beneath it. The inspector follows the
  // cursor, so only one team is ever expanded.
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
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
  }, [shortlist.data]);

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

  // j/k and arrows move the cursor, Enter opens or closes its inspector row, Esc closes it.
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
        setExpanded((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decision]);

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
      post(`Published ${run.name}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizer-shortlist", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-event", eventId] }),
        queryClient.invalidateQueries({ queryKey: ["organizer-events"] }),
      ]);
    },
  });

  const selectedResult = decision?.results.find((result) => result.teamId === selectedTeamId);
  const selectedOverride = overrides.find((override) => override.teamId === selectedTeamId);
  const expandedTeamId = expanded ? selectedTeamId : null;
  const activeRun = shortlist.data?.runs.find((run) => run.id === activeRunId);
  const selectedCount =
    decision?.results.filter((result) => result.status === "selected").length ?? 0;
  const lastSelected = decision?.results.findLastIndex((result) => result.status === "selected");
  const cutoff =
    decision?.cutoffScore != null
      ? {
          score: decision.cutoffScore,
          rank: lastSelected !== undefined ? (decision.results[lastSelected]?.rank ?? null) : null,
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
  const unmapped =
    data.event.quotas.some((quota) => quota.attribute === "college") &&
    data.unmappedColleges.length > 0;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6">
      <ScreenHead
        title="Shortlist"
        actions={
          <>
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
              title={activeRunId ? undefined : "Save a run first"}
              onClick={() => publishRun.mutate()}
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

      {/* ------------------------------------------------------------ tuning */}
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

      {eventId ? <FailedProfiles eventId={eventId} /> : null}

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
                Ranked teams. Use j and k to move, Enter to expand, Escape to collapse.
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
                {decision.results.map((result, index) => {
                  const open = expandedTeamId === result.teamId;
                  const team = data.teams.find((item) => item.teamId === result.teamId);
                  return (
                    <Fragment key={result.teamId}>
                      <tr
                        ref={(node) => {
                          if (node) rowRefs.current.set(result.teamId, node);
                          else rowRefs.current.delete(result.teamId);
                        }}
                        data-clickable
                        aria-selected={selectedTeamId === result.teamId}
                        onClick={() => toggleRow(result.teamId)}
                      >
                        <td data-label="rank" className="num dim">
                          {result.rank ?? "—"}
                        </td>
                        <td data-label="team">
                          <span className="flex flex-wrap items-baseline justify-end gap-x-[1ch] sm:justify-start">
                            <button
                              type="button"
                              className="text-left font-bold"
                              aria-expanded={open}
                              aria-controls={open ? `inspect-${result.teamId}` : undefined}
                            >
                              <span aria-hidden="true" className="dim font-normal">
                                {open ? "▾ " : "▸ "}
                              </span>
                              {result.name}
                            </button>
                            <TeamTags result={result} />
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
    </div>
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
}) {
  const memberName = (personId: string | null) =>
    team.members.find((member) => member.personId === personId)?.name ?? personId;
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
          <span className="font-display text-5xl leading-none text-accent glow">
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
              return (
                <li className="grid content-start" key={member.personId}>
                  <span className="flex flex-wrap items-center gap-x-[1ch]">
                    <Avatar login={member.github} size={24} />
                    {member.name}
                    <span className="dim text-xs">@{member.github}</span>
                    {member.profileStatus === "ready" ? null : (
                      <StateTag
                        state={member.profileStatus}
                        label={`profile ${member.profileStatus}`}
                      />
                    )}
                  </span>
                  <span className="dim text-xs">{member.college ?? "No college"}</span>
                  {profile?.summary ? <p className="mt-1 text-sm">{profile.summary}</p> : null}
                  {flags.length > 0 ? (
                    <span className="flex flex-wrap gap-x-[1ch]">
                      {flags.map((flag) => (
                        <Status tone="warn" key={flag}>
                          {flag.replaceAll("_", " ")}
                        </Status>
                      ))}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Details>

        <Details summary="evidence" meta={evidence.length}>
          {evidence.length === 0 ? (
            <p className="dim">No cited files.</p>
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

export function SavedRunPage() {
  const { eventId, runId } = useParams();
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

function SavedRow({ result, cutoffAfter }: { result: DecidedTeam; cutoffAfter: number | null }) {
  return (
    <>
      <tr>
        <td data-label="rank" className="num dim">
          {result.rank ?? "—"}
        </td>
        <th scope="row" data-label="team" className="font-normal">
          <span className="flex flex-wrap items-baseline justify-end gap-x-[1ch] sm:justify-start">
            <strong>{result.name}</strong>
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
