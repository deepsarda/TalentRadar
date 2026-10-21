export interface SecondOpinionProfile {
  personId: string;
  profileId: string;
  ready: boolean;
  /** The primary assessment; without it there is nothing to second-guess. */
  assessmentId?: string;
  hasSecondOpinion: boolean;
}

export interface SecondOpinionPlan {
  /** People to queue, closest-to-the-cutoff teams first. */
  targets: Array<{ personId: string; profileId: string; assessmentId: string }>;
  borderlineTeams: number;
  /** Distinct people on borderline teams. */
  people: number;
  alreadyDone: number;
  /** Members whose profile is missing, still building or failed. */
  notReady: number;
  /** True when more people qualified than `cap`; the rest were left for a later request. */
  truncated: boolean;
}

/**
 * Decides who gets a second opinion. Only people on borderline teams qualify, because a second
 * judge can only change a decision that was close. `borderlineTeamIds` must already be ordered by
 * priority (nearest the cutoff first) so that, under the cap, the closest calls are covered first.
 */
export function planSecondOpinions(input: {
  borderlineTeamIds: readonly string[];
  teams: ReadonlyArray<{ teamId: string; memberIds: readonly string[] }>;
  profiles: ReadonlyMap<string, SecondOpinionProfile>;
  cap: number;
}): SecondOpinionPlan {
  const membersByTeam = new Map(input.teams.map((team) => [team.teamId, team.memberIds]));
  const seen = new Set<string>();
  const targets: SecondOpinionPlan["targets"] = [];
  let borderlineTeams = 0;
  let alreadyDone = 0;
  let notReady = 0;
  let truncated = false;
  for (const teamId of input.borderlineTeamIds) {
    const memberIds = membersByTeam.get(teamId);
    if (!memberIds) continue;
    borderlineTeams += 1;
    for (const personId of memberIds) {
      if (seen.has(personId)) continue;
      seen.add(personId);
      const profile = input.profiles.get(personId);
      if (!profile?.ready || !profile.assessmentId) {
        notReady += 1;
      } else if (profile.hasSecondOpinion) {
        alreadyDone += 1;
      } else if (targets.length >= input.cap) {
        truncated = true;
      } else {
        targets.push({
          personId,
          profileId: profile.profileId,
          assessmentId: profile.assessmentId,
        });
      }
    }
  }
  return { targets, borderlineTeams, people: seen.size, alreadyDone, notReady, truncated };
}
