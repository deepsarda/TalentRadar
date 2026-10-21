import type { FlagPenalties, PersonProfile, RankingParams, Requirement, Team } from "../schemas.js";
import {
  FlagPenaltiesSchema,
  PersonProfileSchema,
  RankingParamsSchema,
  TeamSchema,
} from "../schemas.js";
import { taxonomy } from "../taxonomy/taxonomy.js";

/** Params after defaults are filled in, so scoring never has to handle a missing penalty. */
type ResolvedParams = RankingParams & {
  flagPenalties: FlagPenalties;
  synergyWeight: number;
  noveltyMaxShare: number;
};

/** Default share of team novelty taken from the single most novel member. */
export const DEFAULT_NOVELTY_MAX_SHARE = 0.5;
/** How much of the synergy score the redundancy penalty can remove (see computeSynergy). */
export const SYNERGY_REDUNDANCY_PENALTY = 0.5;

/** Why a team earned its synergy score; all shares are 0..1. */
export interface SynergyBreakdown {
  /** Weighted share of the requirement domains in which at least one member is strong. */
  balance: number;
  /** Share of members whose only strong domain is the team's single dominant one; 0 if not applicable. */
  redundancy: number;
  /** balance minus SYNERGY_REDUNDANCY_PENALTY * redundancy, clamped to 0..1. */
  score: number;
  coveredDomains: string[];
  uncoveredDomains: string[];
  /** The domain every redundant member is strong in, when redundancy applies. */
  redundantDomain: string | null;
  /** Points added to the team score: synergyWeight * score. */
  points: number;
}

export interface RequirementBreakdown {
  skill: string;
  target: number;
  weight: number;
  teamLevel: number;
  /** Product of the flag penalties on the member who set teamLevel; 1 when that member has none. */
  flagMultiplier: number;
  coverage: number;
  bestMemberId: string | null;
  fitContribution: number;
  depthContribution: number;
  scoreContribution: number;
  fitPointsLost: number;
}

export interface RankedTeam {
  teamId: string;
  rank: number | null;
  eligible: boolean;
  ineligibleReasons: string[];
  score: number;
  fit: number;
  depth: number;
  novelty: number;
  /** Absent on runs saved before synergy existed. */
  synergy?: SynergyBreakdown;
  submittedAt: string;
  breakdown: RequirementBreakdown[];
}

interface MemberLevel {
  memberId: string;
  level: number;
  flagMultiplier: number;
}

/** Each distinct flag counts once, so a duplicated flag cannot be penalised twice. */
/** Pre-indexed profile for fast O(1) skill lookup in inner loops without repeated Zod validation. */
export interface ValidatedProfile extends Omit<PersonProfile, "skills"> {
  skills: PersonProfile["skills"];
  skillsById: Map<string, PersonProfile["skills"][number]>;
}

function toValidatedProfile(profile: PersonProfile): ValidatedProfile {
  return {
    ...profile,
    skillsById: new Map(profile.skills.map((skill) => [skill.id, skill])),
  };
}

function flagMultiplierFor(
  profile: ValidatedProfile | PersonProfile | undefined,
  params: ResolvedParams,
): number {
  if (!profile) return 1;
  return [...new Set(profile.flags)].reduce(
    (product, flag) => product * params.flagPenalties[flag],
    1,
  );
}

function levelFor(
  profile: ValidatedProfile | undefined,
  skillId: string,
  params: ResolvedParams,
): { level: number; flagMultiplier: number } {
  const flagMultiplier = flagMultiplierFor(profile, params);
  const skill = profile?.skillsById.get(skillId);
  if (!skill) return { level: 0, flagMultiplier };
  return {
    level: skill.level * params.confidenceFactors[skill.confidence] * flagMultiplier,
    flagMultiplier,
  };
}

/** Every member's level for one requirement, best first (ties by member id). */
function memberLevelsFor(
  requirement: Requirement,
  team: Team,
  profiles: ReadonlyMap<string, ValidatedProfile>,
  params: ResolvedParams,
): MemberLevel[] {
  return team.memberIds
    .map((memberId) => ({
      memberId,
      ...levelFor(profiles.get(memberId), requirement.skill, params),
    }))
    .sort((left, right) => right.level - left.level || left.memberId.localeCompare(right.memberId));
}

function pickRequirementLevel(requirement: Requirement, levels: MemberLevel[]): MemberLevel | null {
  if (requirement.coverage.mode === "any_member") return levels[0] ?? null;
  return levels[requirement.coverage.minMembers - 1] ?? null;
}

/** The taxonomy domains a skill id belongs to: a domain is its own, a tool lists its domains. */
function domainsOf(skillId: string): string[] {
  if (skillId in taxonomy.domains) return [skillId];
  return taxonomy.technologies[skillId]?.domains ?? [];
}

/**
 * Role balance across the domains the requirements ask for.
 *
 * A member is "strong" in a domain when they reach the target of at least one weighted
 * requirement in it. balance is the weighted share of requirement domains with a strong member.
 * Redundancy applies only to teams of two or more whose requirements span several domains: it is
 * the share of members strong in exactly one domain, the one most members share. The penalty
 * (SYNERGY_REDUNDANCY_PENALTY * redundancy) is subtracted from balance.
 *
 * Deliberate trade-off: because redundancy can grow when a member improves, synergy alone is not
 * monotone in skill levels. With synergyWeight 0 (the default) it has no effect on the score.
 */
function computeSynergy(
  requirements: readonly Requirement[],
  levelsByRequirement: MemberLevel[][],
  memberIds: readonly string[],
  synergyWeight: number,
): SynergyBreakdown {
  const domainWeight = new Map<string, number>();
  const strongIn = new Map<string, Set<string>>(memberIds.map((id) => [id, new Set<string>()]));
  const coveredSet = new Set<string>();
  requirements.forEach((requirement, index) => {
    if (requirement.weight <= 0) return;
    for (const domain of domainsOf(requirement.skill)) {
      domainWeight.set(domain, (domainWeight.get(domain) ?? 0) + requirement.weight);
      for (const { memberId, level } of levelsByRequirement[index] ?? []) {
        if (level >= requirement.target) {
          strongIn.get(memberId)?.add(domain);
          coveredSet.add(domain);
        }
      }
    }
  });
  const totalWeight = [...domainWeight.values()].reduce((sum, weight) => sum + weight, 0);
  const coveredWeight = [...coveredSet].reduce(
    (sum, domain) => sum + (domainWeight.get(domain) ?? 0),
    0,
  );
  const balance = totalWeight > 0 ? coveredWeight / totalWeight : 0;

  let redundancy = 0;
  let redundantDomain: string | null = null;
  if (memberIds.length >= 2 && domainWeight.size >= 2) {
    const counts = new Map<string, number>();
    for (const domains of strongIn.values()) {
      if (domains.size !== 1) continue;
      const [only] = domains;
      if (only) counts.set(only, (counts.get(only) ?? 0) + 1);
    }
    const [dominant, count] = [...counts].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0] ?? [null, 0];
    if (dominant && count >= 2) {
      redundancy = count / memberIds.length;
      redundantDomain = dominant;
    }
  }
  const score = Math.min(1, Math.max(0, balance - SYNERGY_REDUNDANCY_PENALTY * redundancy));
  const domainOrder = [...domainWeight.keys()].sort();
  return {
    balance,
    redundancy,
    score,
    coveredDomains: domainOrder.filter((domain) => coveredSet.has(domain)),
    uncoveredDomains: domainOrder.filter((domain) => !coveredSet.has(domain)),
    redundantDomain,
    points: synergyWeight * score,
  };
}

/**
 * Team novelty: a blend of the most novel member and the mean of the two most novel members, so a
 * team with two original builders edges out a team with one. A one-member team uses that member.
 */
function teamNovelty(
  team: Team,
  profiles: ReadonlyMap<string, ValidatedProfile>,
  maxShare: number,
): number {
  const sorted = team.memberIds
    .map((memberId) => profiles.get(memberId)?.novelty ?? 0)
    .sort((left, right) => right - left);
  const best = sorted[0] ?? 0;
  const topTwo = sorted.slice(0, 2);
  const topTwoMean =
    topTwo.length > 0 ? topTwo.reduce((sum, value) => sum + value, 0) / topTwo.length : 0;
  return maxShare * best + (1 - maxShare) * topTwoMean;
}

function scoreTeam(
  team: Team,
  profiles: ReadonlyMap<string, ValidatedProfile>,
  params: ResolvedParams,
): RankedTeam {
  const totalWeight = params.requirements.reduce((sum, requirement) => sum + requirement.weight, 0);

  // Points left for fit and depth once novelty and synergy have taken their share.
  const basePoints = 100 - params.noveltyWeight - params.synergyWeight;
  const levelsByRequirement = params.requirements.map((requirement) =>
    memberLevelsFor(requirement, team, profiles, params),
  );

  const breakdown = params.requirements.map((requirement, index): RequirementBreakdown => {
    const memberLevel = pickRequirementLevel(requirement, levelsByRequirement[index] ?? []);
    const teamLevel = memberLevel?.level ?? 0;
    const coverage = Math.min(teamLevel / requirement.target, 1);
    const fitContribution = (requirement.weight * coverage) / totalWeight;
    const depthContribution = (requirement.weight * (teamLevel / 5)) / totalWeight;
    const scoreContribution =
      basePoints * (params.alpha * fitContribution + (1 - params.alpha) * depthContribution);
    const fitPointsLost =
      basePoints * params.alpha * (requirement.weight / totalWeight) * (1 - coverage);

    return {
      skill: requirement.skill,
      target: requirement.target,
      weight: requirement.weight,
      teamLevel,
      flagMultiplier: memberLevel?.flagMultiplier ?? 1,
      coverage,
      bestMemberId: teamLevel > 0 ? (memberLevel?.memberId ?? null) : null,
      fitContribution,
      depthContribution,
      scoreContribution,
      fitPointsLost,
    };
  });

  const fit = breakdown.reduce((sum, requirement) => sum + requirement.fitContribution, 0);
  const depth = breakdown.reduce((sum, requirement) => sum + requirement.depthContribution, 0);
  const novelty = teamNovelty(team, profiles, params.noveltyMaxShare);
  const synergy = computeSynergy(
    params.requirements,
    levelsByRequirement,
    team.memberIds,
    params.synergyWeight,
  );
  const score =
    basePoints * (params.alpha * fit + (1 - params.alpha) * depth) +
    params.noveltyWeight * novelty +
    synergy.points;

  const ineligibleReasons: string[] = [];
  if (team.memberIds.length < params.minTeamSize) {
    ineligibleReasons.push(`Team has fewer than ${params.minTeamSize} members`);
  }
  if (team.memberIds.length > params.maxTeamSize) {
    ineligibleReasons.push(`Team has more than ${params.maxTeamSize} members`);
  }
  if (fit < params.minFit) {
    ineligibleReasons.push(`Team fit is below ${Math.round(params.minFit * 100)}%`);
  }

  return {
    teamId: team.teamId,
    rank: null,
    eligible: ineligibleReasons.length === 0,
    ineligibleReasons,
    score,
    fit,
    depth,
    novelty,
    synergy,
    submittedAt: team.submittedAt,
    breakdown,
  };
}

export function resolveRankingParams(rawParams: RankingParams): ResolvedParams {
  const parsedParams = RankingParamsSchema.parse(rawParams);
  return {
    ...parsedParams,
    flagPenalties: FlagPenaltiesSchema.parse(parsedParams.flagPenalties ?? {}),
    synergyWeight: parsedParams.synergyWeight ?? 0,
    noveltyMaxShare: parsedParams.noveltyMaxShare ?? DEFAULT_NOVELTY_MAX_SHARE,
  };
}

export function validateRankInputs(
  rawProfiles: readonly PersonProfile[],
  rawTeams: readonly Team[],
  rawParams: RankingParams,
): {
  profilesById: Map<string, ValidatedProfile>;
  teams: Team[];
  params: ResolvedParams;
} {
  const profiles = rawProfiles.map((profile) => PersonProfileSchema.parse(profile));
  const teams = rawTeams.map((team) => TeamSchema.parse(team));
  const params = resolveRankingParams(rawParams);
  const profilesById = new Map(
    profiles.map((profile) => [profile.personId, toValidatedProfile(profile)]),
  );
  return { profilesById, teams, params };
}

/**
 * Fast scoring path: scores pre-validated profiles and teams with O(1) skill lookups and zero Zod validation.
 * Used inside inner loops (auto-formation, gap-filling, sensitivity perturbations) for peak performance.
 */
export function scoreValidated(
  profilesById: ReadonlyMap<string, ValidatedProfile>,
  teams: readonly Team[],
  params: ResolvedParams,
): RankedTeam[] {
  const sorted = teams
    .map((team) => scoreTeam(team, profilesById, params))
    .sort((left, right) => {
      if (left.eligible !== right.eligible) {
        return left.eligible ? -1 : 1;
      }
      return (
        right.score - left.score ||
        right.fit - left.fit ||
        right.depth - left.depth ||
        Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
        left.teamId.localeCompare(right.teamId)
      );
    });

  let nextRank = 1;
  return sorted.map((team) => ({
    ...team,
    rank: team.eligible ? nextRank++ : null,
  }));
}

export function rank(
  rawProfiles: readonly PersonProfile[],
  rawTeams: readonly Team[],
  rawParams: RankingParams,
): RankedTeam[] {
  const { profilesById, teams, params } = validateRankInputs(rawProfiles, rawTeams, rawParams);
  return scoreValidated(profilesById, teams, params);
}
