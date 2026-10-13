import type { PersonProfile, RankingParams, Requirement, Team } from "../schemas.js";
import { PersonProfileSchema, RankingParamsSchema, TeamSchema } from "../schemas.js";

export interface RequirementBreakdown {
  skill: string;
  target: number;
  weight: number;
  teamLevel: number;
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
  submittedAt: string;
  breakdown: RequirementBreakdown[];
}

interface MemberLevel {
  memberId: string;
  level: number;
}

function levelFor(profile: PersonProfile | undefined, skillId: string): number {
  return profile?.skills.find((skill) => skill.id === skillId)?.effective ?? 0;
}

function requirementLevel(
  requirement: Requirement,
  team: Team,
  profiles: ReadonlyMap<string, PersonProfile>,
): MemberLevel | null {
  const levels = team.memberIds
    .map((memberId) => ({ memberId, level: levelFor(profiles.get(memberId), requirement.skill) }))
    .sort((left, right) => right.level - left.level || left.memberId.localeCompare(right.memberId));

  if (requirement.coverage.mode === "any_member") {
    return levels[0] ?? null;
  }

  return levels[requirement.coverage.minMembers - 1] ?? null;
}

function scoreTeam(
  team: Team,
  profiles: ReadonlyMap<string, PersonProfile>,
  params: RankingParams,
): RankedTeam {
  const totalWeight = params.requirements.reduce((sum, requirement) => sum + requirement.weight, 0);

  const breakdown = params.requirements.map((requirement): RequirementBreakdown => {
    const memberLevel = requirementLevel(requirement, team, profiles);
    const teamLevel = memberLevel?.level ?? 0;
    const coverage = Math.min(teamLevel / requirement.target, 1);
    const fitContribution = (requirement.weight * coverage) / totalWeight;
    const depthContribution = (requirement.weight * (teamLevel / 5)) / totalWeight;
    const scoreContribution =
      (100 - params.noveltyWeight) *
      (params.alpha * fitContribution + (1 - params.alpha) * depthContribution);
    const fitPointsLost =
      (100 - params.noveltyWeight) *
      params.alpha *
      (requirement.weight / totalWeight) *
      (1 - coverage);

    return {
      skill: requirement.skill,
      target: requirement.target,
      weight: requirement.weight,
      teamLevel,
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
  const novelty = Math.max(
    0,
    ...team.memberIds.map((memberId) => profiles.get(memberId)?.novelty ?? 0),
  );
  const score =
    (100 - params.noveltyWeight) * (params.alpha * fit + (1 - params.alpha) * depth) +
    params.noveltyWeight * novelty;

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
    submittedAt: team.submittedAt,
    breakdown,
  };
}

export function rank(
  rawProfiles: readonly PersonProfile[],
  rawTeams: readonly Team[],
  rawParams: RankingParams,
): RankedTeam[] {
  const profiles = rawProfiles.map((profile) => PersonProfileSchema.parse(profile));
  const teams = rawTeams.map((team) => TeamSchema.parse(team));
  const params = RankingParamsSchema.parse(rawParams);
  const profilesById = new Map(profiles.map((profile) => [profile.personId, profile]));

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
