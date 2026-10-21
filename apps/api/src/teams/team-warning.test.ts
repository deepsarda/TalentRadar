import { describe, expect, it } from "vitest";
import { TEAM_WARNING_DAYS, teamWarning } from "./team-warning.js";

const closes = new Date("2026-11-15T18:29:00Z");
const hoursBefore = (hours: number) => new Date(closes.getTime() - hours * 3_600_000);
const base = { minTeamSize: 2, registrationClosesAt: closes, hasTeam: false };

describe("teamWarning", () => {
  it("is silent more than 3 days before close", () => {
    expect(teamWarning({ ...base, now: hoursBefore(TEAM_WARNING_DAYS * 24 + 1) })).toBeNull();
  });

  it("warns from exactly 3 days before close", () => {
    const warning = teamWarning({ ...base, now: hoursBefore(TEAM_WARNING_DAYS * 24) });
    expect(warning?.level).toBe("upcoming");
    expect(warning?.message).toContain("closes in 3 days");
    expect(warning?.message).toContain("at least 2 members");
  });

  it("counts partial days up, and switches to hours in the last day", () => {
    expect(teamWarning({ ...base, now: hoursBefore(30) })?.message).toContain("in 2 days");
    expect(teamWarning({ ...base, now: hoursBefore(5) })?.message).toContain("in 5 hours");
    expect(teamWarning({ ...base, now: new Date(closes.getTime() - 60_000) })?.message).toContain(
      "in 1 hour.",
    );
  });

  it("says the participant is ineligible once close has passed", () => {
    const warning = teamWarning({ ...base, now: hoursBefore(-1) });
    expect(warning?.level).toBe("ineligible");
    expect(warning?.message).toContain("ineligible");
    expect(teamWarning({ ...base, now: closes })?.level).toBe("ineligible");
  });

  it("never warns someone who has a team", () => {
    expect(teamWarning({ ...base, hasTeam: true, now: hoursBefore(5) })).toBeNull();
    expect(teamWarning({ ...base, hasTeam: true, now: hoursBefore(-5) })).toBeNull();
  });

  it("never warns when solo applicants are allowed", () => {
    expect(teamWarning({ ...base, minTeamSize: 1, now: hoursBefore(5) })).toBeNull();
    expect(teamWarning({ ...base, minTeamSize: 1, now: hoursBefore(-5) })).toBeNull();
  });

  it("is silent when the event has no registration close", () => {
    expect(
      teamWarning({ ...base, registrationClosesAt: undefined, now: hoursBefore(5) }),
    ).toBeNull();
  });
});
