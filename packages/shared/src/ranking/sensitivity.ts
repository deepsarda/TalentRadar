import type { PersonProfile, RankingParams, Team } from "../schemas.js";
import { rank } from "./rank.js";

/** Simple seeded LCG RNG (Numerical Recipes parameters) — pure, no external deps. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223;
    return (state >>> 0) / 0x100000000;
  };
}

export interface TeamSensitivity {
  teamId: string;
  /** Lowest rank observed across all perturbations; null when the team was ineligible in all. */
  minRank: number | null;
  /** Middle rank observed (lower median); null when the team was ineligible in all. */
  medianRank: number | null;
  /** Highest rank observed; null when the team was ineligible in all. */
  maxRank: number | null;
  /**
   * stable   — max-min ≤ 1 (or ineligible throughout)
   * borderline — max-min ≤ 3
   * unstable — max-min > 3
   */
  stability: "stable" | "borderline" | "unstable";
}

export interface SensitivityResult {
  teams: TeamSensitivity[];
  perturbations: number;
  seed: number;
}

export interface SensitivityOptions {
  /** How many perturbed runs to compute. Default 50, max 200. */
  perturbations?: number;
  /** Seed for the RNG so results are reproducible. Default 42. */
  seed?: number;
}

/** Maximum perturbation added/subtracted to alpha. */
const ALPHA_DELTA = 0.1;
/** Maximum perturbation added/subtracted to noveltyWeight (integer steps). */
const NOVELTY_DELTA = 1;
/** Maximum perturbation added/subtracted to each confidence factor. */
const CONFIDENCE_DELTA = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lowerMedianRanks(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/**
 * Runs N seeded perturbations of the ranking params (alpha ±0.1, noveltyWeight ±1,
 * confidenceFactors ±0.05) and returns per-team min/median/max rank and a stability label.
 *
 * Results are fully reproducible: the same seed always produces the same output.
 * N is capped at 200 to bound runtime.
 */
export function sensitivity(
  profiles: readonly PersonProfile[],
  teams: readonly Team[],
  params: RankingParams,
  options: SensitivityOptions = {},
): SensitivityResult {
  const seed = options.seed ?? 42;
  const n = Math.min(200, Math.max(1, options.perturbations ?? 50));
  const rng = lcg(seed);

  // ranks[teamId] = list of numeric ranks across perturbations (ineligible = omitted)
  const rankHistory = new Map<string, number[]>();
  for (const team of teams) rankHistory.set(team.teamId, []);

  for (let i = 0; i < n; i++) {
    const perturbedParams: RankingParams = {
      ...params,
      alpha: clamp(params.alpha + (rng() * 2 - 1) * ALPHA_DELTA, 0, 1),
      noveltyWeight: clamp(params.noveltyWeight + (rng() > 0.5 ? 1 : -1) * NOVELTY_DELTA, 0, 25),
      confidenceFactors: {
        high: clamp(
          (params.confidenceFactors?.high ?? 1) + (rng() * 2 - 1) * CONFIDENCE_DELTA,
          0,
          1,
        ),
        medium: clamp(
          (params.confidenceFactors?.medium ?? 0.85) + (rng() * 2 - 1) * CONFIDENCE_DELTA,
          0,
          1,
        ),
        low: clamp(
          (params.confidenceFactors?.low ?? 0.6) + (rng() * 2 - 1) * CONFIDENCE_DELTA,
          0,
          1,
        ),
      },
    };
    const ranked = rank([...profiles], [...teams], perturbedParams);
    for (const rankedTeam of ranked) {
      if (rankedTeam.rank !== null) {
        rankHistory.get(rankedTeam.teamId)?.push(rankedTeam.rank);
      }
    }
  }

  const sensitivityTeams: TeamSensitivity[] = teams.map((team) => {
    const history = rankHistory.get(team.teamId) ?? [];
    if (history.length === 0) {
      return {
        teamId: team.teamId,
        minRank: null,
        medianRank: null,
        maxRank: null,
        stability: "stable",
      };
    }
    const minRank = Math.min(...history);
    const maxRank = Math.max(...history);
    const medianRank = lowerMedianRanks(history);
    const spread = maxRank - minRank;
    const stability: TeamSensitivity["stability"] =
      spread <= 1 ? "stable" : spread <= 3 ? "borderline" : "unstable";
    return { teamId: team.teamId, minRank, medianRank, maxRank, stability };
  });

  return { teams: sensitivityTeams, perturbations: n, seed };
}
