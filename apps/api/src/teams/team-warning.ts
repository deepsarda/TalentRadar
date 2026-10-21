/** Spec: when the minimum team size is above 1, a participant without a team at close is
 * ineligible, and their status page warns them 3 days before close. */
export const TEAM_WARNING_DAYS = 3;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface TeamWarning {
  /** `upcoming`: close is near. `ineligible`: close has passed and there is still no team. */
  level: "upcoming" | "ineligible";
  message: string;
}

export interface TeamWarningInput {
  minTeamSize: number;
  registrationClosesAt: Date | undefined;
  hasTeam: boolean;
  now: Date;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** Null when no warning applies: solos are allowed, a team exists, or close is still far off. */
export function teamWarning(input: TeamWarningInput): TeamWarning | null {
  if (input.minTeamSize <= 1 || input.hasTeam || !input.registrationClosesAt) return null;

  const remaining = input.registrationClosesAt.getTime() - input.now.getTime();
  if (remaining <= 0) {
    return {
      level: "ineligible",
      message: `Registration has closed and you are not on a team. Teams need at least ${plural(input.minTeamSize, "member")}, so you are ineligible for this shortlist.`,
    };
  }
  if (remaining > TEAM_WARNING_DAYS * DAY_MS) return null;

  const when =
    remaining < DAY_MS
      ? `in ${plural(Math.max(1, Math.ceil(remaining / HOUR_MS)), "hour")}`
      : `in ${plural(Math.ceil(remaining / DAY_MS), "day")}`;
  return {
    level: "upcoming",
    message: `Registration closes ${when}. Teams need at least ${plural(input.minTeamSize, "member")}; without a team by then you will be ineligible. Create a team, join one with a code, or ask a teammate for theirs.`,
  };
}
