import { describe, expect, it } from "vitest";
import { DEFAULT_FLAG_PENALTIES, RankingParamsSchema } from "../schemas.js";
import {
  workedExampleParams,
  workedExampleProfiles,
  workedExampleTeams,
} from "./__tests__/fixtures.js";
import { rank } from "./rank.js";

type Flag = "possible_prompt_injection" | "readme_overclaims" | "mostly_boilerplate";

function withFlags(personId: string, flags: Flag[]) {
  return workedExampleProfiles.map((profile) =>
    profile.personId === personId ? { ...profile, flags } : profile,
  );
}

function team(results: ReturnType<typeof rank>, teamId: string) {
  const found = results.find((result) => result.teamId === teamId);
  if (!found) throw new Error(`missing team ${teamId}`);
  return found;
}

describe("flag penalties", () => {
  it("leaves unflagged profiles exactly as before", () => {
    const results = rank(workedExampleProfiles, workedExampleTeams, workedExampleParams);
    expect(team(results, "alpha").score).toBeCloseTo(82.0375, 4);
    expect(team(results, "beta").score).toBeCloseTo(75.9175, 4);
    expect(team(results, "beta").breakdown.every((item) => item.flagMultiplier === 1)).toBe(true);
  });

  it("scales the flagged member's levels by the default multiplier", () => {
    // arjun is the best ai_ml member of beta (4.5); with the 0.5 injection multiplier he drops
    // to 2.25 and sana (4.1) becomes the best member.
    const results = rank(
      withFlags("arjun", ["possible_prompt_injection"]),
      workedExampleTeams,
      workedExampleParams,
    );
    const beta = team(results, "beta");
    const aiMl = beta.breakdown.find((item) => item.skill === "ai_ml");
    expect(aiMl?.bestMemberId).toBe("sana");
    expect(aiMl?.teamLevel).toBeCloseTo(4.1, 6);
    expect(aiMl?.flagMultiplier).toBe(1);
    const backend = beta.breakdown.find((item) => item.skill === "backend");
    expect(backend?.teamLevel).toBeCloseTo(3.8 * 0.5, 6);
    expect(backend?.flagMultiplier).toBe(0.5);
    expect(beta.score).toBeLessThan(75.9175);
  });

  it("multiplies the penalties of several distinct flags", () => {
    const beta = team(
      rank(
        withFlags("arjun", ["readme_overclaims", "mostly_boilerplate"]),
        workedExampleTeams,
        workedExampleParams,
      ),
      "beta",
    );
    const backend = beta.breakdown.find((item) => item.skill === "backend");
    expect(backend?.flagMultiplier).toBeCloseTo(0.85 * 0.8, 10);
  });

  it("does not penalise a duplicated flag twice", () => {
    const once = team(
      rank(withFlags("arjun", ["readme_overclaims"]), workedExampleTeams, workedExampleParams),
      "beta",
    );
    const twice = team(
      rank(
        withFlags("arjun", ["readme_overclaims", "readme_overclaims"]),
        workedExampleTeams,
        workedExampleParams,
      ),
      "beta",
    );
    expect(twice.score).toBeCloseTo(once.score, 10);
  });

  it("uses organizer-supplied penalties, and 1 turns a flag off", () => {
    const off = rank(withFlags("arjun", ["possible_prompt_injection"]), workedExampleTeams, {
      ...workedExampleParams,
      flagPenalties: { ...DEFAULT_FLAG_PENALTIES, possible_prompt_injection: 1 },
    });
    expect(team(off, "beta").score).toBeCloseTo(75.9175, 4);

    const harsh = rank(withFlags("arjun", ["possible_prompt_injection"]), workedExampleTeams, {
      ...workedExampleParams,
      flagPenalties: { ...DEFAULT_FLAG_PENALTIES, possible_prompt_injection: 0 },
    });
    const backend = team(harsh, "beta").breakdown.find((item) => item.skill === "backend");
    expect(backend?.teamLevel).toBe(0);
  });

  it("can change which team ranks first", () => {
    const clean = rank(workedExampleProfiles, workedExampleTeams, workedExampleParams);
    expect(clean[0]?.teamId).toBe("alpha");
    // Flag Riya (alpha's only ai_ml member) as a prompt-injection attempt: alpha loses fit.
    const flagged = rank(
      withFlags("riya", ["possible_prompt_injection"]),
      workedExampleTeams,
      workedExampleParams,
    );
    expect(team(flagged, "alpha").score).toBeLessThan(team(clean, "alpha").score);
  });

  it("stays backwards compatible: params saved without flagPenalties still parse", () => {
    const { flagPenalties: _omit, ...legacy } =
      workedExampleParams as typeof workedExampleParams & {
        flagPenalties?: unknown;
      };
    const parsed = RankingParamsSchema.parse(legacy);
    expect(parsed.flagPenalties).toBeUndefined();
    expect(() => rank(workedExampleProfiles, workedExampleTeams, parsed)).not.toThrow();
  });

  it("fills missing individual penalties with the defaults", () => {
    const parsed = RankingParamsSchema.parse({
      ...workedExampleParams,
      flagPenalties: { possible_prompt_injection: 0.2 },
    });
    expect(parsed.flagPenalties).toEqual({
      ...DEFAULT_FLAG_PENALTIES,
      possible_prompt_injection: 0.2,
    });
  });

  it("rejects penalties outside 0 to 1", () => {
    for (const value of [-0.1, 1.1]) {
      expect(() =>
        RankingParamsSchema.parse({
          ...workedExampleParams,
          flagPenalties: { readme_overclaims: value },
        }),
      ).toThrow();
    }
  });
});
