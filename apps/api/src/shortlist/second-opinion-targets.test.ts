import { describe, expect, it } from "vitest";
import { planSecondOpinions, type SecondOpinionProfile } from "./second-opinion-targets.js";

function profile(personId: string, overrides: Partial<SecondOpinionProfile> = {}) {
  return [
    personId,
    {
      personId,
      profileId: `profile-${personId}`,
      ready: true,
      assessmentId: `assessment-${personId}`,
      hasSecondOpinion: false,
      ...overrides,
    },
  ] as const;
}

const teams = [
  { teamId: "t1", memberIds: ["a", "b"] },
  { teamId: "t2", memberIds: ["c", "d"] },
  { teamId: "t3", memberIds: ["e"] },
];

describe("planSecondOpinions", () => {
  it("queues only members of the borderline teams, in priority order", () => {
    const plan = planSecondOpinions({
      borderlineTeamIds: ["t2", "t1"],
      teams,
      profiles: new Map(["a", "b", "c", "d", "e"].map((id) => profile(id))),
      cap: 60,
    });
    expect(plan.targets.map((target) => target.personId)).toEqual(["c", "d", "a", "b"]);
    expect(plan.borderlineTeams).toBe(2);
    expect(plan.people).toBe(4);
    expect(plan.truncated).toBe(false);
  });

  it("carries the primary assessment id and skips finished or unready profiles", () => {
    const plan = planSecondOpinions({
      borderlineTeamIds: ["t1", "t2"],
      teams,
      profiles: new Map([
        profile("a"),
        profile("b", { hasSecondOpinion: true }),
        profile("c", { ready: false }),
        profile("d", { assessmentId: undefined as unknown as string }),
      ]),
      cap: 60,
    });
    expect(plan.targets).toEqual([
      { personId: "a", profileId: "profile-a", assessmentId: "assessment-a" },
    ]);
    expect(plan.alreadyDone).toBe(1);
    expect(plan.notReady).toBe(2);
  });

  it("counts a member with no profile at all as not ready", () => {
    const plan = planSecondOpinions({
      borderlineTeamIds: ["t3"],
      teams,
      profiles: new Map(),
      cap: 60,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.notReady).toBe(1);
  });

  it("stops at the cap, keeps the closest teams, and reports truncation", () => {
    const plan = planSecondOpinions({
      borderlineTeamIds: ["t1", "t2", "t3"],
      teams,
      profiles: new Map(["a", "b", "c", "d", "e"].map((id) => profile(id))),
      cap: 3,
    });
    expect(plan.targets.map((target) => target.personId)).toEqual(["a", "b", "c"]);
    expect(plan.truncated).toBe(true);
    expect(plan.people).toBe(5);
  });

  it("does not queue the same person twice and ignores unknown teams", () => {
    const plan = planSecondOpinions({
      borderlineTeamIds: ["t1", "ghost", "t1"],
      teams,
      profiles: new Map(["a", "b"].map((id) => profile(id))),
      cap: 60,
    });
    expect(plan.targets.map((target) => target.personId)).toEqual(["a", "b"]);
    expect(plan.borderlineTeams).toBe(2);
  });

  it("does nothing when no team is borderline", () => {
    const plan = planSecondOpinions({
      borderlineTeamIds: [],
      teams,
      profiles: new Map(["a"].map((id) => profile(id))),
      cap: 60,
    });
    expect(plan).toEqual({
      targets: [],
      borderlineTeams: 0,
      people: 0,
      alreadyDone: 0,
      notReady: 0,
      truncated: false,
    });
  });
});
