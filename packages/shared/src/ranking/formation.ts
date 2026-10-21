import type { PersonProfile, RankingParams, Team } from "../schemas.js";
import {
  rank,
  resolveRankingParams,
  scoreValidated,
  type ValidatedProfile,
  validateRankInputs,
} from "./rank.js";

export interface CandidateSkillInput {
  id: string;
  level: number;
  confidence?: "high" | "medium" | "low" | string;
  effective?: number;
  evidence?: PersonProfile["skills"][number]["evidence"];
  thought?: string;
}

export interface CandidateWithSkills {
  personId: string;
  name: string;
  github?: string;
  college?: string;
  skills: CandidateSkillInput[];
}

export interface TeamGapCandidate {
  candidate: CandidateWithSkills;
  scoreGain: number;
  fitGain: number;
  coveredRequirements: string[];
  newTeamScore: number;
}

export interface TeamGapAnalysis {
  teamId: string;
  currentScore: number;
  currentFit: number;
  unmetRequirements: Array<{
    skill: string;
    target: number;
    currentLevel: number;
    deficit: number;
  }>;
  suggestedCandidates: TeamGapCandidate[];
}

function normalizeCandidateSkills(
  skills: readonly CandidateSkillInput[],
  params: RankingParams,
): PersonProfile["skills"] {
  return skills.map((s) => {
    const conf: "high" | "medium" | "low" =
      s.confidence === "low" || s.confidence === "medium" ? s.confidence : "high";
    return {
      id: s.id,
      level: s.level,
      confidence: conf,
      effective: s.effective ?? s.level * params.confidenceFactors[conf],
      evidence: s.evidence ?? [],
      thought: s.thought ?? "",
    };
  });
}

/**
 * Evaluates available candidates to find who best fills a team's requirement deficits.
 * Pure in-memory calculation using the canonical rank() scoring.
 */
export function findTeamGapFillers(
  team: Team,
  currentProfiles: readonly PersonProfile[],
  candidates: readonly CandidateWithSkills[],
  params: RankingParams,
  limit = 5,
): TeamGapAnalysis {
  const currentRanked = rank(currentProfiles, [team], params)[0];
  const currentScore = currentRanked ? Math.round(currentRanked.score * 10) / 10 : 0;
  const currentFit = currentRanked ? Math.round(currentRanked.fit * 100) / 100 : 0;

  const unmetRequirements = (currentRanked?.breakdown ?? [])
    .filter((b) => b.teamLevel < b.target)
    .map((b) => ({
      skill: b.skill,
      target: b.target,
      currentLevel: Math.round(b.teamLevel * 10) / 10,
      deficit: Math.round((b.target - b.teamLevel) * 10) / 10,
    }))
    .sort((a, b) => b.deficit - a.deficit);

  // If team is full or already at maxTeamSize, no slots to fill
  if (team.memberIds.length >= params.maxTeamSize) {
    return {
      teamId: team.teamId,
      currentScore,
      currentFit,
      unmetRequirements,
      suggestedCandidates: [],
    };
  }

  // Pre-build profile map with pre-indexed skills and resolved params
  const resolvedParams = resolveRankingParams(params);
  const { profilesById: baseProfiles } = validateRankInputs(
    currentProfiles,
    [team],
    resolvedParams,
  );

  const candidateGains: TeamGapCandidate[] = [];

  for (const candidate of candidates) {
    if (team.memberIds.includes(candidate.personId)) continue;

    const candidateNormalizedSkills = normalizeCandidateSkills(candidate.skills, resolvedParams);
    const candidateProfile: ValidatedProfile = {
      personId: candidate.personId,
      displayName: candidate.name,
      skills: candidateNormalizedSkills,
      skillsById: new Map(candidateNormalizedSkills.map((s) => [s.id, s])),
      novelty: 0,
      flags: [],
    };

    const hypotheticalTeam: Team = {
      ...team,
      memberIds: [...team.memberIds, candidate.personId],
    };

    const allProfiles = new Map(baseProfiles);
    allProfiles.set(candidate.personId, candidateProfile);
    const hypotheticalRanked = scoreValidated(allProfiles, [hypotheticalTeam], resolvedParams)[0];

    if (!hypotheticalRanked) continue;

    const scoreGain =
      Math.round((hypotheticalRanked.score - (currentRanked?.score ?? 0)) * 10) / 10;
    const fitGain = Math.round((hypotheticalRanked.fit - (currentRanked?.fit ?? 0)) * 100) / 100;

    // Determine which unmet requirements this candidate helps cover
    const coveredRequirements: string[] = [];
    for (const unmet of unmetRequirements) {
      const hypBreakdown = hypotheticalRanked.breakdown.find((b) => b.skill === unmet.skill);
      if (hypBreakdown && hypBreakdown.teamLevel > unmet.currentLevel + 1e-6) {
        coveredRequirements.push(unmet.skill);
      }
    }

    if (scoreGain > 0 || fitGain > 0 || coveredRequirements.length > 0) {
      candidateGains.push({
        candidate,
        scoreGain,
        fitGain,
        coveredRequirements,
        newTeamScore: Math.round(hypotheticalRanked.score * 10) / 10,
      });
    }
  }

  // Sort by score gain descending, then by covered requirements count, then fit gain
  candidateGains.sort((a, b) => {
    return (
      b.scoreGain - a.scoreGain ||
      b.coveredRequirements.length - a.coveredRequirements.length ||
      b.fitGain - a.fitGain ||
      a.candidate.name.localeCompare(b.candidate.name)
    );
  });

  return {
    teamId: team.teamId,
    currentScore,
    currentFit,
    unmetRequirements,
    suggestedCandidates: candidateGains.slice(0, limit),
  };
}

export interface FormedTeam {
  teamName: string;
  memberIds: string[];
  members: CandidateWithSkills[];
  score: number;
  fit: number;
  coveredSkillsCount: number;
}

export interface FormationResult {
  formedTeams: FormedTeam[];
  unassignedCandidates: CandidateWithSkills[];
}

/**
 * Algorithmic combinatorial team builder for solo applicants who opted into "looking for team".
 * Greedy complementarity matching:
 * 1. Iteratively seeds a team with the candidate having highest overall skill depth.
 * 2. Greedily adds available candidates who maximize the team's combined coverage of requirements.
 * 3. Continues until teams reach target size (clamped between minTeamSize and maxTeamSize).
 * Deterministic and fast in memory with zero LLM calls.
 */
export function autoFormTeams(
  candidates: readonly CandidateWithSkills[],
  params: RankingParams,
  options?: {
    targetTeamSize?: number;
    teamNamePrefix?: string;
  },
): FormationResult {
  const targetSize = Math.max(
    params.minTeamSize,
    Math.min(params.maxTeamSize, options?.targetTeamSize ?? Math.min(params.maxTeamSize, 4)),
  );
  const prefix = options?.teamNamePrefix ?? "Formed Team";

  const available = new Map<string, CandidateWithSkills>(
    candidates.map((candidate) => [candidate.personId, candidate]),
  );

  const formedTeams: FormedTeam[] = [];
  let teamCounter = 1;

  const resolvedParams = resolveRankingParams(params);
  const validatedCandidatePool = new Map<string, ValidatedProfile>();
  for (const candidate of candidates) {
    const normSkills = normalizeCandidateSkills(candidate.skills, resolvedParams);
    validatedCandidatePool.set(candidate.personId, {
      personId: candidate.personId,
      displayName: candidate.name,
      skills: normSkills,
      skillsById: new Map(normSkills.map((s) => [s.id, s])),
      novelty: 0,
      flags: [],
    });
  }

  while (available.size >= params.minTeamSize) {
    // If not enough remaining candidates to form even minTeamSize, stop
    if (available.size < params.minTeamSize) break;

    // Pick seed: candidate with highest total skill level
    let bestSeed: CandidateWithSkills | null = null;
    let highestTotal = -1;

    for (const cand of available.values()) {
      const sumSkills = cand.skills.reduce((sum, s) => sum + s.level, 0);
      if (sumSkills > highestTotal) {
        highestTotal = sumSkills;
        bestSeed = cand;
      }
    }

    if (!bestSeed) break;

    const currentMembers: CandidateWithSkills[] = [bestSeed];
    available.delete(bestSeed.personId);

    // Greedily fill up to targetSize
    while (currentMembers.length < targetSize && available.size > 0) {
      let bestCandidate: CandidateWithSkills | null = null;
      let maxGain = -Infinity;

      const currentTeam: Team = {
        teamId: "building",
        name: "building",
        memberIds: currentMembers.map((m) => m.personId),
        submittedAt: new Date(0).toISOString(),
      };

      const currentProfilesMap = new Map<string, ValidatedProfile>(
        currentMembers.map((m) => [m.personId, validatedCandidatePool.get(m.personId)!]),
      );

      const baseRanked = scoreValidated(currentProfilesMap, [currentTeam], resolvedParams)[0];
      const baseScore = baseRanked?.score ?? 0;

      for (const candidate of available.values()) {
        const hypProfilesMap = new Map(currentProfilesMap);
        hypProfilesMap.set(candidate.personId, validatedCandidatePool.get(candidate.personId)!);
        const hypTeam: Team = {
          ...currentTeam,
          memberIds: [...currentTeam.memberIds, candidate.personId],
        };

        const hypRanked = scoreValidated(hypProfilesMap, [hypTeam], resolvedParams)[0];
        const gain = (hypRanked?.score ?? 0) - baseScore;

        if (gain > maxGain) {
          maxGain = gain;
          bestCandidate = candidate;
        }
      }

      if (bestCandidate) {
        currentMembers.push(bestCandidate);
        available.delete(bestCandidate.personId);
      } else {
        break;
      }
    }

    // Evaluate final formed team
    const finalTeam: Team = {
      teamId: `auto-${teamCounter}`,
      name: `${prefix} ${teamCounter}`,
      memberIds: currentMembers.map((m) => m.personId),
      submittedAt: new Date().toISOString(),
    };
    const finalProfilesMap = new Map<string, ValidatedProfile>(
      currentMembers.map((m) => [m.personId, validatedCandidatePool.get(m.personId)!]),
    );

    const finalRanked = scoreValidated(finalProfilesMap, [finalTeam], resolvedParams)[0];
    const coveredCount = (finalRanked?.breakdown ?? []).filter(
      (b) => b.teamLevel >= b.target,
    ).length;

    formedTeams.push({
      teamName: `${prefix} ${teamCounter}`,
      memberIds: currentMembers.map((m) => m.personId),
      members: currentMembers,
      score: finalRanked ? Math.round(finalRanked.score * 10) / 10 : 0,
      fit: finalRanked ? Math.round(finalRanked.fit * 100) / 100 : 0,
      coveredSkillsCount: coveredCount,
    });

    teamCounter++;
  }

  return {
    formedTeams,
    unassignedCandidates: [...available.values()],
  };
}
