import type { QuotaRule } from "../schemas.js";
import { QuotaRuleSchema } from "../schemas.js";
import type { RankedTeam } from "./rank.js";

export interface SelectionMember {
  personId: string;
  college?: string;
  yearOfStudy?: string;
  branch?: string;
  city?: string;
}

export interface SelectionTeam {
  teamId: string;
  name: string;
  memberIds: string[];
  members: SelectionMember[];
}

export interface SelectionOverride {
  teamId: string;
  action: "pin_in" | "pin_out";
  reason: string;
}

export interface QuotaReport {
  quota: QuotaRule;
  actualShare: number;
  targetShare: number;
  met: boolean;
  message: string;
}

export interface QuotaSwap {
  quotaIndex: number;
  addedTeamId: string;
  removedTeamId: string;
  message: string;
}

export type DecisionStatus = "selected" | "waitlisted" | "not_selected" | "ineligible";

export interface DecidedTeam extends RankedTeam {
  name: string;
  memberIds: string[];
  status: DecisionStatus;
  waitlistPosition: number | null;
  borderline: boolean;
  override?: SelectionOverride;
  quotaSwap?: "added" | "removed";
}

export interface ShortlistDecision {
  results: DecidedTeam[];
  selectedSeats: number;
  cutoffScore: number | null;
  swaps: QuotaSwap[];
  quotaReports: QuotaReport[];
}

export interface SelectionParams {
  capacity: number;
  waitlistSize: number;
  quotas?: readonly QuotaRule[];
  overrides?: readonly SelectionOverride[];
  borderlinePoints?: number;
}

function memberAttribute(member: SelectionMember, attribute: QuotaRule["attribute"]): string {
  if (attribute === "year_of_study") return member.yearOfStudy?.trim() ?? "";
  return (member[attribute] ?? "").trim();
}

function memberMatches(member: SelectionMember, quota: QuotaRule): boolean {
  const actual = memberAttribute(member, quota.attribute).toLocaleLowerCase();
  const expected = (Array.isArray(quota.value) ? quota.value : [quota.value]).map((value) =>
    value.trim().toLocaleLowerCase(),
  );
  const included = expected.includes(actual);
  return quota.op === "equals" || quota.op === "in" ? included : !included;
}

function matchingUnits(team: SelectionTeam, quota: QuotaRule): number {
  const matchingMembers = team.members.filter((member) => memberMatches(member, quota)).length;
  if (quota.unit === "participants") return matchingMembers;
  if (team.members.length === 0) return 0;
  if (quota.match === "any") return matchingMembers > 0 ? 1 : 0;
  if (quota.match === "majority") return matchingMembers > team.members.length / 2 ? 1 : 0;
  return matchingMembers === team.members.length ? 1 : 0;
}

function quotaShare(
  teamIds: ReadonlySet<string>,
  teams: ReadonlyMap<string, SelectionTeam>,
  quota: QuotaRule,
): number {
  const selected = [...teamIds]
    .map((teamId) => teams.get(teamId))
    .filter((team): team is SelectionTeam => Boolean(team));
  const denominator =
    quota.unit === "participants"
      ? selected.reduce((sum, team) => sum + team.memberIds.length, 0)
      : selected.length;
  if (denominator === 0) return 0;
  return selected.reduce((sum, team) => sum + matchingUnits(team, quota), 0) / denominator;
}

function quotaMessage(quota: QuotaRule, actualShare: number, hasCandidates: boolean): string {
  const label = `${quota.attribute.replaceAll("_", " ")} quota`;
  const actual = Math.round(actualShare * 100);
  const target = Math.round(quota.minShare * 100);
  return actualShare >= quota.minShare
    ? `${label} met at ${actual}% (target ${target}%)`
    : `${label} at ${actual}% (target ${target}%): ${hasCandidates ? "capacity prevents another improving swap" : "no eligible teams left"}`;
}

function selectedSeatCount(
  selected: ReadonlySet<string>,
  teams: ReadonlyMap<string, SelectionTeam>,
): number {
  return [...selected].reduce((sum, teamId) => sum + (teams.get(teamId)?.memberIds.length ?? 0), 0);
}

export function selectShortlist(
  rankedTeams: readonly RankedTeam[],
  rawTeams: readonly SelectionTeam[],
  params: SelectionParams,
): ShortlistDecision {
  if (!Number.isInteger(params.capacity) || params.capacity < 1 || params.capacity > 5000) {
    throw new Error("Capacity must be an integer from 1 to 5000");
  }
  if (
    !Number.isInteger(params.waitlistSize) ||
    params.waitlistSize < 0 ||
    params.waitlistSize > 500
  ) {
    throw new Error("Waitlist size must be an integer from 0 to 500");
  }

  const quotas = (params.quotas ?? []).map((quota) => QuotaRuleSchema.parse(quota));
  const teams = new Map(rawTeams.map((team) => [team.teamId, team]));
  const ranked = rankedTeams.filter((team) => teams.has(team.teamId));
  const overrides = new Map(
    (params.overrides ?? []).map((override) => {
      if (!override.reason.trim()) throw new Error("Every shortlist override needs a reason");
      return [override.teamId, { ...override, reason: override.reason.trim() }];
    }),
  );
  const selected = new Set<string>();

  for (const team of ranked) {
    const override = overrides.get(team.teamId);
    if (!team.eligible || override?.action !== "pin_in") continue;
    const selectionTeam = teams.get(team.teamId);
    if (!selectionTeam) continue;
    if (selectedSeatCount(selected, teams) + selectionTeam.memberIds.length > params.capacity) {
      throw new Error("Pinned-in teams exceed event capacity");
    }
    selected.add(team.teamId);
  }

  for (const team of ranked) {
    if (
      !team.eligible ||
      selected.has(team.teamId) ||
      overrides.get(team.teamId)?.action === "pin_out"
    ) {
      continue;
    }
    const selectionTeam = teams.get(team.teamId);
    if (!selectionTeam) continue;
    if (selectedSeatCount(selected, teams) + selectionTeam.memberIds.length <= params.capacity) {
      selected.add(team.teamId);
    }
  }

  const swaps: QuotaSwap[] = [];
  const quotaSwapState = new Map<string, "added" | "removed">();
  const eligibleRanked = ranked.filter(
    (team) => team.eligible && overrides.get(team.teamId)?.action !== "pin_out",
  );
  const maxSwaps = Math.max(1, eligibleRanked.length * Math.max(1, quotas.length));

  for (let pass = 0; pass < maxSwaps; pass += 1) {
    const quotaIndex = quotas.findIndex(
      (quota) => quotaShare(selected, teams, quota) < quota.minShare,
    );
    if (quotaIndex < 0) break;
    const quota = quotas[quotaIndex];
    if (!quota) break;
    const previouslyMet = quotas.map(
      (candidate) => quotaShare(selected, teams, candidate) >= candidate.minShare,
    );
    let pair: { incoming: RankedTeam; outgoing: RankedTeam; incomingTeam: SelectionTeam } | null =
      null;
    for (const incoming of eligibleRanked) {
      if (selected.has(incoming.teamId)) continue;
      const incomingTeam = teams.get(incoming.teamId);
      if (!incomingTeam || matchingUnits(incomingTeam, quota) === 0) continue;
      const outgoing = [...ranked].reverse().find((rankedTeam) => {
        if (!selected.has(rankedTeam.teamId)) return false;
        if (overrides.get(rankedTeam.teamId)?.action === "pin_in") return false;
        const outgoingTeam = teams.get(rankedTeam.teamId);
        if (
          !outgoingTeam ||
          matchingUnits(outgoingTeam, quota) >= matchingUnits(incomingTeam, quota)
        ) {
          return false;
        }
        const next = new Set(selected);
        next.delete(rankedTeam.teamId);
        next.add(incoming.teamId);
        if (selectedSeatCount(next, teams) > params.capacity) return false;
        if (quotaShare(next, teams, quota) <= quotaShare(selected, teams, quota)) return false;
        return quotas.every(
          (candidate, index) =>
            !previouslyMet[index] || quotaShare(next, teams, candidate) >= candidate.minShare,
        );
      });
      if (outgoing) {
        pair = { incoming, outgoing, incomingTeam };
        break;
      }
    }
    if (!pair) break;
    const { incoming, outgoing, incomingTeam } = pair;

    selected.delete(outgoing.teamId);
    selected.add(incoming.teamId);
    quotaSwapState.set(incoming.teamId, "added");
    quotaSwapState.set(outgoing.teamId, "removed");
    swaps.push({
      quotaIndex,
      addedTeamId: incoming.teamId,
      removedTeamId: outgoing.teamId,
      message: `${incomingTeam.name} (score ${incoming.score.toFixed(1)}) replaced ${teams.get(outgoing.teamId)?.name ?? outgoing.teamId} (score ${outgoing.score.toFixed(1)}) to improve the ${quota.attribute.replaceAll("_", " ")} quota.`,
    });
  }

  const cutoffScore = ranked.filter((team) => selected.has(team.teamId)).at(-1)?.score ?? null;
  const waitlistIds = ranked
    .filter(
      (team) =>
        team.eligible &&
        !selected.has(team.teamId) &&
        overrides.get(team.teamId)?.action !== "pin_out",
    )
    .slice(0, params.waitlistSize)
    .map((team) => team.teamId);
  const waitlistPositions = new Map(waitlistIds.map((teamId, index) => [teamId, index + 1]));
  const borderlinePoints = params.borderlinePoints ?? 3;

  const results = ranked.map((team): DecidedTeam => {
    const selectionTeam = teams.get(team.teamId);
    if (!selectionTeam) throw new Error(`Missing team metadata for ${team.teamId}`);
    const teamOverride = overrides.get(team.teamId);
    const teamQuotaSwap = quotaSwapState.get(team.teamId);
    const status: DecisionStatus = !team.eligible
      ? "ineligible"
      : selected.has(team.teamId)
        ? "selected"
        : waitlistPositions.has(team.teamId)
          ? "waitlisted"
          : "not_selected";
    return {
      ...team,
      name: selectionTeam.name,
      memberIds: selectionTeam.memberIds,
      status,
      waitlistPosition: waitlistPositions.get(team.teamId) ?? null,
      borderline: cutoffScore !== null && Math.abs(team.score - cutoffScore) <= borderlinePoints,
      ...(teamOverride ? { override: teamOverride } : {}),
      ...(teamQuotaSwap ? { quotaSwap: teamQuotaSwap } : {}),
    };
  });

  const unselectedTeamsRemain = results.some(
    (team) => team.eligible && team.status !== "selected" && team.override?.action !== "pin_out",
  );
  const quotaReports = quotas.map((quota) => {
    const actualShare = quotaShare(selected, teams, quota);
    return {
      quota,
      actualShare,
      targetShare: quota.minShare,
      met: actualShare >= quota.minShare,
      message: quotaMessage(quota, actualShare, unselectedTeamsRemain),
    };
  });

  return {
    results,
    selectedSeats: selectedSeatCount(selected, teams),
    cutoffScore,
    swaps,
    quotaReports,
  };
}
