import type { QuotaRule } from "../schemas.js";
import { QuotaRuleSchema } from "../schemas.js";
import type { RankedTeam } from "./rank.js";
import {
  type QuotaReport,
  type QuotaSwap,
  type SelectionMember,
  type SelectionOverride,
  type SelectionTeam,
  type ShortlistDecision,
  selectShortlist,
} from "./select.js";

export interface OptimizedDecision extends ShortlistDecision {
  /**
   * true when the optimizer found a provably-optimal feasible solution within the budget.
   * false when the budget was exceeded and the result is the greedy fallback.
   */
  optimized: boolean;
  /** Set when no feasible solution exists that satisfies all quota minimums. */
  infeasible?: boolean;
  /** Human-readable reason for infeasibility or budget exhaustion. */
  optimizerNote?: string;
}

/** Branch-and-bound time budget per call in milliseconds. */
const TIME_BUDGET_MS = 200;
/** Maximum nodes explored before falling back to greedy. */
const NODE_BUDGET = 10_000;

function memberCount(teamIds: string[], teamsById: Map<string, SelectionTeam>): number {
  return teamIds.reduce((sum, id) => sum + (teamsById.get(id)?.memberIds.length ?? 0), 0);
}

function quotaShare(
  teamIds: string[],
  teamsById: Map<string, SelectionTeam>,
  quota: QuotaRule,
): number {
  const selected = teamIds.map((id) => teamsById.get(id)).filter(Boolean) as SelectionTeam[];
  function memberAttribute(member: SelectionMember): string {
    if (quota.attribute === "year_of_study") return member.yearOfStudy?.trim() ?? "";
    return (member[quota.attribute] ?? "").trim();
  }
  function memberMatches(member: SelectionMember): boolean {
    const actual = memberAttribute(member).toLocaleLowerCase();
    const expected = (Array.isArray(quota.value) ? quota.value : [quota.value]).map((v) =>
      v.trim().toLocaleLowerCase(),
    );
    const included = expected.includes(actual);
    return quota.op === "equals" || quota.op === "in" ? included : !included;
  }
  function matchingUnits(team: SelectionTeam): number {
    const matchingMembers = team.members.filter(memberMatches).length;
    if (quota.unit === "participants") return matchingMembers;
    if (team.members.length === 0) return 0;
    if (quota.match === "any") return matchingMembers > 0 ? 1 : 0;
    if (quota.match === "majority") return matchingMembers > team.members.length / 2 ? 1 : 0;
    return matchingMembers === team.members.length ? 1 : 0;
  }
  const denominator =
    quota.unit === "participants"
      ? selected.reduce((sum, team) => sum + team.memberIds.length, 0)
      : selected.length;
  if (denominator === 0) return 0;
  return selected.reduce((sum, team) => sum + matchingUnits(team), 0) / denominator;
}

function allQuotasMet(
  selected: string[],
  teamsById: Map<string, SelectionTeam>,
  quotas: QuotaRule[],
): boolean {
  return quotas.every((quota) => quotaShare(selected, teamsById, quota) >= quota.minShare);
}

/**
 * Bounded branch-and-bound optimizer. Iterates over eligible teams in rank order,
 * deciding include/exclude for each. Prunes branches that cannot beat the current best.
 *
 * Returns null if the budget is exhausted before finding any feasible solution, or the
 * best feasible selection found within the budget.
 */
function boundedOptimize(
  eligibleTeams: RankedTeam[], // in rank order, best first
  teamsById: Map<string, SelectionTeam>,
  pinnedIn: Set<string>,
  pinnedOut: Set<string>,
  capacity: number,
  quotas: QuotaRule[],
  startTime: number,
): { selected: string[]; score: number; budgetExceeded: boolean } | null {
  let bestScore = -Infinity;
  let bestSelected: string[] | null = null;
  let nodesExplored = 0;
  let budgetExceeded = false;

  // Precompute cumulative suffix scores for upper-bound pruning
  const suffixMaxScore = new Array<number>(eligibleTeams.length + 1).fill(0);
  for (let i = eligibleTeams.length - 1; i >= 0; i--) {
    suffixMaxScore[i] = (suffixMaxScore[i + 1] ?? 0) + (eligibleTeams[i]?.score ?? 0);
  }

  function dfs(index: number, selected: string[], currentScore: number, seatsUsed: number): void {
    if (budgetExceeded) return;
    nodesExplored++;
    if (nodesExplored > NODE_BUDGET || Date.now() - startTime > TIME_BUDGET_MS) {
      budgetExceeded = true;
      return;
    }

    // Check if current solution is feasible and better
    if (index === eligibleTeams.length || seatsUsed === capacity) {
      if (allQuotasMet(selected, teamsById, quotas)) {
        if (currentScore > bestScore) {
          bestScore = currentScore;
          bestSelected = [...selected];
        }
      }
      return;
    }

    // Upper-bound pruning: even including every remaining team can't beat current best
    const upperBound = currentScore + (suffixMaxScore[index] ?? 0);
    if (upperBound <= bestScore) return;

    const team = eligibleTeams[index];
    if (!team) return;
    const selectionTeam = teamsById.get(team.teamId);
    const teamSize = selectionTeam?.memberIds.length ?? 0;

    // Branch: include team (if it fits and isn't pinned out)
    if (!pinnedOut.has(team.teamId) && seatsUsed + teamSize <= capacity) {
      selected.push(team.teamId);
      dfs(index + 1, selected, currentScore + team.score, seatsUsed + teamSize);
      selected.pop();
    }

    // Branch: exclude team (if it isn't pinned in)
    if (!pinnedIn.has(team.teamId)) {
      dfs(index + 1, selected, currentScore, seatsUsed);
    }
  }

  // Start with all pinned-in teams
  const initialSelected = eligibleTeams.filter((t) => pinnedIn.has(t.teamId)).map((t) => t.teamId);
  const initialSeats = memberCount(initialSelected, teamsById);
  const initialScore = eligibleTeams
    .filter((t) => pinnedIn.has(t.teamId))
    .reduce((sum, t) => sum + t.score, 0);

  dfs(0, [...initialSelected], initialScore, initialSeats);
  if (budgetExceeded && bestSelected === null) return null;
  return { selected: bestSelected ?? initialSelected, score: bestScore, budgetExceeded };
}

export interface SelectionParams {
  capacity: number;
  waitlistSize: number;
  quotas?: readonly QuotaRule[];
  overrides?: readonly SelectionOverride[];
  borderlinePoints?: number;
}

/**
 * Optimized shortlist selection. Attempts exact branch-and-bound optimization; falls back
 * to the greedy result from selectShortlist() if the search budget is exceeded.
 *
 * The optimizer never produces a worse result than greedy.
 */
export function optimizeShortlist(
  rankedTeams: readonly RankedTeam[],
  rawTeams: readonly SelectionTeam[],
  params: SelectionParams,
): OptimizedDecision {
  const startTime = Date.now();
  const quotas = (params.quotas ?? []).map((q) => QuotaRuleSchema.parse(q));
  const teamsById = new Map(rawTeams.map((t) => [t.teamId, t]));

  const overrides = new Map(
    (params.overrides ?? []).map((o) => {
      if (!o.reason.trim()) throw new Error("Every shortlist override needs a reason");
      return [o.teamId, o];
    }),
  );

  const pinnedIn = new Set(
    [...overrides.values()].filter((o) => o.action === "pin_in").map((o) => o.teamId),
  );
  const pinnedOut = new Set(
    [...overrides.values()].filter((o) => o.action === "pin_out").map((o) => o.teamId),
  );

  // Always compute greedy as baseline/fallback
  const greedy = selectShortlist(rankedTeams, rawTeams, params);

  // Only run the optimizer when the search space is tractable
  const eligibleTeams = rankedTeams.filter(
    (t) => t.eligible && teamsById.has(t.teamId) && !pinnedOut.has(t.teamId),
  );

  // If no quotas, greedy is already optimal (it fills by score order)
  if (quotas.length === 0) {
    return { ...greedy, optimized: true, optimizerNote: "No quotas: greedy is optimal." };
  }

  const optResult = boundedOptimize(
    eligibleTeams,
    teamsById,
    pinnedIn,
    pinnedOut,
    params.capacity,
    quotas,
    startTime,
  );

  if (!optResult || optResult.budgetExceeded) {
    return {
      ...greedy,
      optimized: false,
      optimizerNote: "Budget exceeded; using greedy fallback.",
    };
  }

  // If optimizer result is not better than greedy, use greedy
  const optimizedScore = optResult.score;
  const greedyScore = greedy.results
    .filter((r) => r.status === "selected")
    .reduce((sum, r) => sum + r.score, 0);

  if (optimizedScore <= greedyScore) {
    return { ...greedy, optimized: true, optimizerNote: "Optimizer confirmed greedy solution." };
  }

  // Re-run selectShortlist with pinned selections to get full DecidedTeam output
  // We pin in the optimizer's selected teams and pin out the rest
  const optimizerSelected = new Set(optResult.selected);
  const optimizerOverrides: SelectionOverride[] = [
    // Keep original pins
    ...(params.overrides ?? []),
    // Pin in every team the optimizer chose (that isn't already pinned)
    ...eligibleTeams
      .filter((t) => optimizerSelected.has(t.teamId) && !pinnedIn.has(t.teamId))
      .map(
        (t): SelectionOverride => ({
          teamId: t.teamId,
          action: "pin_in",
          reason: "Optimizer selection",
        }),
      ),
    // Pin out every team the optimizer rejected (that isn't already pinned out)
    ...eligibleTeams
      .filter((t) => !optimizerSelected.has(t.teamId) && !pinnedOut.has(t.teamId))
      .map(
        (t): SelectionOverride => ({
          teamId: t.teamId,
          action: "pin_out",
          reason: "Optimizer rejection",
        }),
      ),
  ];

  try {
    const optimizedDecision = selectShortlist(rankedTeams, rawTeams, {
      ...params,
      overrides: optimizerOverrides,
    });
    return {
      ...optimizedDecision,
      optimized: true,
      optimizerNote: "Exact optimizer found better solution than greedy.",
    };
  } catch {
    // If re-running with optimizer pins fails (e.g. capacity conflict), fall back
    return { ...greedy, optimized: false, optimizerNote: "Optimizer pin-in failed; using greedy." };
  }
}
