import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Authentication } from "../auth/github.js";
import { createTeamApi, rankTeammates, teamFit } from "./team-api.js";

const userId = new ObjectId();
const personId = new ObjectId();
const eventA = new ObjectId();
const eventB = new ObjectId();

/** Just enough of Db to record the registration query the route makes. */
function fakeDb(registrationQueries: Array<{ hackathonId?: ObjectId }>) {
  const collection = (name: string) => ({
    findOne: async (filter: { _id?: ObjectId; hackathonId?: ObjectId }) => {
      if (name === "people") return { _id: personId, name: "Riya", github: "riya" };
      if (name === "registrations") {
        registrationQueries.push(filter);
        return {
          _id: new ObjectId(),
          hackathonId: filter.hackathonId,
          personId,
          lookingForTeam: false,
        };
      }
      if (name === "hackathons") {
        return { _id: filter._id, name: "Event", teamSize: { min: 2, max: 4 } };
      }
      return null;
    },
  });
  return { collection } as never;
}

function appWith(registrationQueries: Array<{ hackathonId?: ObjectId }>) {
  const authentication = {
    currentUser: async () => ({ id: userId.toHexString() }),
  } as unknown as Authentication;
  const app = express();
  createTeamApi(fakeDb(registrationQueries), authentication).register(app);
  return app;
}

describe("participant team lookup", () => {
  it("requires the event, because a person has one team per hackathon", async () => {
    const response = await request(appWith([])).get("/api/participant/team").expect(422);
    expect(response.body.error).toBe("validation_failed");
  });

  it("loads the registration for the requested event, not the latest one", async () => {
    const queries: Array<{ hackathonId?: ObjectId }> = [];
    const app = appWith(queries);
    const response = await request(app)
      .get(`/api/participant/team?eventId=${eventB.toHexString()}`)
      .expect(200);

    expect(queries[0]?.hackathonId).toEqual(eventB);
    expect(queries[0]?.hackathonId).not.toEqual(eventA);
    expect(response.body.event.id).toBe(eventB.toHexString());
  });
});

const factors = { high: 1, medium: 0.85, low: 0.6 };
const requirements = [
  { skill: "ai_ml", target: 3, weight: 3, coverage: { mode: "any_member" as const } },
  { skill: "backend", target: 3, weight: 2, coverage: { mode: "any_member" as const } },
  { skill: "design", target: 2, weight: 1, coverage: { mode: "any_member" as const } },
];
function member(id: string, skills: Array<[string, number, "low" | "medium" | "high"]>) {
  return {
    id,
    name: id,
    skills: skills.map(([skill, level, confidence]) => ({
      id: skill,
      level,
      confidence,
      effective: level * factors[confidence],
      evidence: [],
      thought: "",
    })),
  };
}
const riya = member("Riya", [
  ["ai_ml", 4, "high"],
  ["design", 1, "high"],
]);
const kabir = member("Kabir", [["backend", 3.5, "high"]]);

describe("team fit", () => {
  it("names the best member per requirement and what is missing", () => {
    const fit = teamFit(requirements, factors, [riya, kabir]);
    expect(fit).toEqual([
      { skill: "ai_ml", target: 3, level: 4, best: { id: "Riya", name: "Riya" }, covered: true },
      {
        skill: "backend",
        target: 3,
        level: 3.5,
        best: { id: "Kabir", name: "Kabir" },
        covered: true,
      },
      { skill: "design", target: 2, level: 1, best: { id: "Riya", name: "Riya" }, covered: false },
    ]);
  });

  it("applies confidence factors and has no best member without evidence", () => {
    const fit = teamFit(requirements, factors, [member("Meera", [["design", 4, "low"]])]);
    expect(fit.find((row) => row.skill === "design")?.level).toBe(2.4);
    expect(fit.find((row) => row.skill === "ai_ml")?.best).toBeNull();
  });
});

describe("teammate suggestions", () => {
  it("ranks the pool by the missing coverage each person adds", () => {
    const designer = member("Sana", [["design", 3, "high"]]);
    const partial = member("Dev", [["design", 1.5, "high"]]);
    const redundant = member("Arjun", [["ai_ml", 5, "high"]]);
    expect(
      rankTeammates(requirements, factors, [riya, kabir], [redundant, partial, designer]),
    ).toEqual([
      { id: "Sana", gain: 0.5, fills: ["design"] },
      { id: "Dev", gain: 0.25, fills: ["design"] },
    ]);
  });
});

describe("participant-only team data", () => {
  function emptyApp() {
    const collection = (name: string) => ({
      findOne: async () => (name === "people" ? { _id: personId, name: "Riya" } : null),
    });
    const authentication = {
      currentUser: async () => ({ id: userId.toHexString() }),
    } as unknown as Authentication;
    const app = express();
    createTeamApi({ collection } as never, authentication).register(app);
    return app;
  }

  it("hides another team's fit and the pool from non-applicants", async () => {
    await request(emptyApp())
      .get(`/api/participant/teams/${new ObjectId().toHexString()}/fit`)
      .expect(404);
    const pool = await request(emptyApp())
      .get(`/api/participant/teammates?eventId=${eventA.toHexString()}`)
      .expect(404);
    expect(pool.body.error).toBe("application_required");
  });
});
