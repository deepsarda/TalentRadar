import { randomInt } from "node:crypto";
import {
  type PersonProfile,
  type RankingParams,
  type Requirement,
  rank,
} from "@talentradar/shared";
import type { Express, Request, Response } from "express";
import type { ClientSession, Db } from "mongodb";
import { MongoServerError, ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type {
  HackathonDocument,
  PersonDocument,
  ProfileDocument,
  RegistrationDocument,
  TeamDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import type { ApiModule } from "../events/organizer-events.js";

const TeamNameSchema = z.object({
  eventId: z.string().length(24),
  name: z.string().trim().min(2).max(80),
});
const JoinTeamSchema = z.object({ inviteCode: z.string().trim().min(8).max(12) });
const EventIdSchema = z.string().refine((value) => ObjectId.isValid(value) && value.length === 24);
const TeamQuerySchema = z.object({ eventId: EventIdSchema });
const LookingForTeamSchema = z.object({ eventId: EventIdSchema, lookingForTeam: z.boolean() });
const inviteAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

class TeamConflictError extends Error {}

function inviteCode(): string {
  return Array.from({ length: 8 }, () => inviteAlphabet[randomInt(inviteAlphabet.length)]).join("");
}

export async function currentPerson(
  authentication: Authentication,
  db: Db,
  request: Request,
  response: Response,
): Promise<PersonDocument | null> {
  const user = await authentication.currentUser(request);
  if (!user) {
    response.status(401).json({
      error: "authentication_required",
      message: "Sign in with GitHub to manage an event team",
    });
    return null;
  }
  const person = await db
    .collection<PersonDocument>(collections.people)
    .findOne({ userId: ObjectId.createFromHexString(user.id) });
  if (!person) throw new Error("Verified person record is missing");
  return person;
}

async function openEvent(db: Db, eventId: ObjectId, session?: ClientSession) {
  return db.collection<HackathonDocument>(collections.hackathons).findOne(
    {
      _id: eventId,
      kind: "event",
      visibility: "published",
      "timeline.registrationClosesAt": { $gte: new Date() },
    },
    { ...(session ? { session } : {}) },
  );
}

async function teamResponse(db: Db, team: TeamDocument) {
  const members = await db
    .collection<PersonDocument>(collections.people)
    .find({ _id: { $in: team.memberIds } })
    .toArray();
  const profiles = await db
    .collection<ProfileDocument>(collections.profiles)
    .aggregate<{ _id: ObjectId; personId: ObjectId; status: ProfileDocument["status"] }>([
      { $match: { personId: { $in: team.memberIds } } },
      { $sort: { version: -1 } },
      {
        $group: {
          _id: "$personId",
          personId: { $first: "$personId" },
          status: { $first: "$status" },
        },
      },
    ])
    .toArray();
  const profileByPerson = new Map(
    profiles.map((profile) => [profile.personId.toHexString(), profile.status]),
  );
  return {
    id: team._id.toHexString(),
    hackathonId: team.hackathonId.toHexString(),
    name: team.name,
    inviteCode: team.inviteCode,
    captainId: team.captainId.toHexString(),
    status: team.status,
    submittedAt: team.submittedAt?.toISOString(),
    members: members.map((member) => ({
      id: member._id.toHexString(),
      name: member.name,
      github: member.github,
      profileStatus: profileByPerson.get(member._id.toHexString()) ?? "pending",
    })),
  };
}

export interface FitMember {
  id: string;
  name: string;
  skills: PersonProfile["skills"];
}

export interface FitRow {
  skill: string;
  target: number;
  level: number;
  best: { id: string; name: string } | null;
  covered: boolean;
}

/**
 * Levels per published requirement, computed by the real ranking function so the card can never
 * disagree with the shortlist. Weights are flattened to 1: they do not change levels, and the
 * organizer's weights are not public. Nothing score- or rank-shaped is returned.
 */
function rankFitTeams(
  requirements: readonly Requirement[],
  confidenceFactors: RankingParams["confidenceFactors"],
  teams: ReadonlyArray<{ teamId: string; members: readonly FitMember[] }>,
) {
  const profiles = new Map<string, PersonProfile>();
  for (const member of teams.flatMap((team) => team.members)) {
    profiles.set(member.id, {
      personId: member.id,
      displayName: member.name || "member",
      skills: member.skills,
      novelty: 0,
      flags: [],
    });
  }
  const ranked = rank(
    [...profiles.values()],
    teams.map((team) => ({
      teamId: team.teamId,
      name: team.teamId,
      memberIds: team.members.map((member) => member.id),
      submittedAt: new Date(0).toISOString(),
    })),
    {
      requirements: requirements.map((requirement) => ({ ...requirement, weight: 1 })),
      alpha: 1,
      noveltyWeight: 0,
      confidenceFactors,
      minFit: 0,
      minTeamSize: 1,
      maxTeamSize: 6,
    },
  );
  return new Map(ranked.map((team) => [team.teamId, team.breakdown]));
}

export function teamFit(
  requirements: readonly Requirement[],
  confidenceFactors: RankingParams["confidenceFactors"],
  members: readonly FitMember[],
): FitRow[] {
  if (requirements.length === 0 || members.length === 0) return [];
  const names = new Map(members.map((member) => [member.id, member.name]));
  const breakdown = rankFitTeams(requirements, confidenceFactors, [{ teamId: "team", members }]);
  return (breakdown.get("team") ?? []).map((row) => ({
    skill: row.skill,
    target: row.target,
    level: Math.round(row.teamLevel * 10) / 10,
    best: row.bestMemberId
      ? { id: row.bestMemberId, name: names.get(row.bestMemberId) ?? "member" }
      : null,
    covered: row.coverage >= 1,
  }));
}

/**
 * Orders looking-for-team candidates by how much requirement coverage they would add to the team
 * (each requirement counts up to its target, so strength on an already-covered skill adds nothing).
 * Candidates who add nothing are dropped.
 */
export function rankTeammates(
  requirements: readonly Requirement[],
  confidenceFactors: RankingParams["confidenceFactors"],
  team: readonly FitMember[],
  candidates: readonly FitMember[],
): Array<{ id: string; gain: number; fills: string[] }> {
  if (requirements.length === 0 || candidates.length === 0 || team.length >= 6) return [];
  const breakdowns = rankFitTeams(requirements, confidenceFactors, [
    { teamId: "base", members: team },
    ...candidates.map((candidate) => ({
      teamId: `with:${candidate.id}`,
      members: [...team, candidate],
    })),
  ]);
  const base = new Map((breakdowns.get("base") ?? []).map((row) => [row.skill, row.coverage]));
  return candidates
    .flatMap((candidate) => {
      const rows = breakdowns.get(`with:${candidate.id}`) ?? [];
      const fills = rows
        .filter((row) => row.coverage > (base.get(row.skill) ?? 0) + 1e-9)
        .map((row) => row.skill);
      const gain = rows.reduce(
        (sum, row) => sum + Math.max(0, row.coverage - (base.get(row.skill) ?? 0)),
        0,
      );
      return gain > 1e-9 ? [{ id: candidate.id, name: candidate.name, gain, fills }] : [];
    })
    .sort((left, right) => right.gain - left.gain || left.name.localeCompare(right.name))
    .map(({ id, gain, fills }) => ({ id, gain: Math.round(gain * 100) / 100, fills }));
}

/** Latest ready profile per person; people still building contribute no skills yet. */
async function readySkills(db: Db, personIds: ObjectId[]) {
  const profiles = personIds.length
    ? await db
        .collection<ProfileDocument>(collections.profiles)
        .find({ personId: { $in: personIds }, status: "ready" })
        .sort({ personId: 1, version: -1 })
        .toArray()
    : [];
  const skillsByPerson = new Map<string, PersonProfile["skills"]>();
  for (const profile of profiles) {
    const id = profile.personId.toHexString();
    if (!skillsByPerson.has(id)) skillsByPerson.set(id, profile.skills);
  }
  return skillsByPerson;
}

async function fitMembers(db: Db, people: PersonDocument[]): Promise<FitMember[]> {
  const skills = await readySkills(
    db,
    people.map((person) => person._id),
  );
  return people.map((person) => ({
    id: person._id.toHexString(),
    name: person.name,
    skills: skills.get(person._id.toHexString()) ?? [],
  }));
}

export function createTeamApi(db: Db, authentication: Authentication): ApiModule {
  return {
    register(app: Express) {
      app.get("/api/participant/team", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        // A person has one team per hackathon, so the caller must say which hackathon.
        const eventId = TeamQuerySchema.safeParse(request.query);
        if (!eventId.success) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Choose which event's team to load" });
          return;
        }
        const registration = await db
          .collection<RegistrationDocument>(collections.registrations)
          .findOne({
            personId: person._id,
            hackathonId: ObjectId.createFromHexString(eventId.data.eventId),
          });
        if (!registration) {
          response.status(404).json({
            error: "application_required",
            message: "Apply to an event before forming a team",
          });
          return;
        }
        const event = await db
          .collection<HackathonDocument>(collections.hackathons)
          .findOne({ _id: registration.hackathonId });
        if (!event) throw new Error("Application event is missing");
        const team = registration.teamId
          ? await db
              .collection<TeamDocument>(collections.teams)
              .findOne({ _id: registration.teamId })
          : null;
        response.json({
          registration: {
            id: registration._id.toHexString(),
            lookingForTeam: registration.lookingForTeam,
          },
          event: {
            id: event._id.toHexString(),
            name: event.name,
            teamSize: event.teamSize,
            registrationClosesAt: event.timeline?.registrationClosesAt.toISOString(),
          },
          team: team ? await teamResponse(db, team) : null,
          personId: person._id.toHexString(),
        });
      });

      app.get("/api/participant/teams/:teamId/fit", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const teamId = request.params.teamId;
        const team =
          teamId && ObjectId.isValid(teamId)
            ? await db
                .collection<TeamDocument>(collections.teams)
                .findOne({ _id: ObjectId.createFromHexString(teamId), memberIds: person._id })
            : null;
        const event = team
          ? await db
              .collection<HackathonDocument>(collections.hackathons)
              .findOne({ _id: team.hackathonId })
          : null;
        if (!team || !event) {
          response.status(404).json({ error: "team_not_found", message: "Team not found" });
          return;
        }
        const people = await db
          .collection<PersonDocument>(collections.people)
          .find({ _id: { $in: team.memberIds } })
          .toArray();
        response.json({
          fit: teamFit(
            event.requirements,
            event.ranking.confidenceFactors,
            await fitMembers(db, people),
          ),
        });
      });

      app.get("/api/participant/teammates", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const query = TeamQuerySchema.safeParse(request.query);
        if (!query.success) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Choose which event to search" });
          return;
        }
        const hackathonId = ObjectId.createFromHexString(query.data.eventId);
        const registrations = db.collection<RegistrationDocument>(collections.registrations);
        // Only applicants of this event may see its pool.
        const registration = await registrations.findOne({ hackathonId, personId: person._id });
        if (!registration) {
          response.status(404).json({
            error: "application_required",
            message: "Apply to this event to see people looking for a team",
          });
          return;
        }
        const event = await openEvent(db, hackathonId);
        const team = registration.teamId
          ? await db
              .collection<TeamDocument>(collections.teams)
              .findOne({ _id: registration.teamId })
          : null;
        if (
          !event ||
          (team && (team.status !== "draft" || team.memberIds.length >= event.teamSize.max))
        ) {
          response.json({ suggestions: [] });
          return;
        }
        // Opted in, still teamless, not the caller. 500 is far above any real pool for one event.
        const pool = await registrations
          .find({
            hackathonId,
            lookingForTeam: true,
            teamId: { $exists: false },
            personId: { $ne: person._id },
          })
          .limit(500)
          .toArray();
        const people = db.collection<PersonDocument>(collections.people);
        const [teamPeople, candidatePeople] = await Promise.all([
          team
            ? people.find({ _id: { $in: team.memberIds } }).toArray()
            : Promise.resolve([person]),
          pool.length
            ? people.find({ _id: { $in: pool.map((entry) => entry.personId) } }).toArray()
            : Promise.resolve([]),
        ]);
        const candidates = await fitMembers(db, candidatePeople);
        const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const collegeById = new Map(
          candidatePeople.map((candidate) => [candidate._id.toHexString(), candidate.college]),
        );
        const ranked = rankTeammates(
          event.requirements,
          event.ranking.confidenceFactors,
          await fitMembers(db, teamPeople),
          candidates,
        ).slice(0, 10);
        response.json({
          suggestions: ranked.map((suggestion) => {
            const candidate = candidatesById.get(suggestion.id);
            const college = collegeById.get(suggestion.id);
            return {
              id: suggestion.id,
              name: candidate?.name ?? "Participant",
              ...(college ? { college } : {}),
              topSkills: [...(candidate?.skills ?? [])]
                .sort((left, right) => right.effective - left.effective)
                .slice(0, 3)
                .map((skill) => ({ id: skill.id, level: skill.effective })),
              fills: suggestion.fills,
            };
          }),
        });
      });

      app.post("/api/participant/teams", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const parsed = TeamNameSchema.safeParse(request.body);
        if (!parsed.success || !ObjectId.isValid(parsed.data?.eventId ?? "")) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Choose an event and valid team name" });
          return;
        }
        const eventId = ObjectId.createFromHexString(parsed.data.eventId);
        const session = db.client.startSession();
        let createdTeam: TeamDocument | null = null;
        try {
          await session.withTransaction(async () => {
            const [event, registration] = await Promise.all([
              openEvent(db, eventId, session),
              db
                .collection<RegistrationDocument>(collections.registrations)
                .findOne(
                  { hackathonId: eventId, personId: person._id, teamId: { $exists: false } },
                  { session },
                ),
            ]);
            if (!event || !registration)
              throw new TeamConflictError("Event is closed or you already joined a team");
            const now = new Date();
            const team: Omit<TeamDocument, "_id"> = {
              hackathonId: eventId,
              name: parsed.data.name,
              inviteCode: inviteCode(),
              captainId: person._id,
              memberIds: [person._id],
              status: "draft",
              createdAt: now,
              updatedAt: now,
            };
            const inserted = await db
              .collection<TeamDocument>(collections.teams)
              .insertOne(team as TeamDocument, { session });
            const attached = await db
              .collection<RegistrationDocument>(collections.registrations)
              .updateOne(
                { _id: registration._id, teamId: { $exists: false } },
                { $set: { teamId: inserted.insertedId, lookingForTeam: false, updatedAt: now } },
                { session },
              );
            if (attached.modifiedCount !== 1)
              throw new TeamConflictError("Team membership changed concurrently");
            createdTeam = { ...team, _id: inserted.insertedId };
          });
        } catch (error) {
          if (
            error instanceof TeamConflictError ||
            (error instanceof MongoServerError && error.code === 11000)
          ) {
            response.status(409).json({ error: "team_conflict", message: error.message });
            return;
          }
          throw error;
        } finally {
          await session.endSession();
        }
        if (!createdTeam) throw new Error("Team was not created");
        response.status(201).json({ team: await teamResponse(db, createdTeam) });
      });

      app.post("/api/participant/teams/join", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const parsed = JoinTeamSchema.safeParse(request.body);
        if (!parsed.success) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Enter a valid invite code" });
          return;
        }
        const code = parsed.data.inviteCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const candidate = await db
          .collection<TeamDocument>(collections.teams)
          .findOne({ inviteCode: code });
        if (!candidate) {
          response
            .status(404)
            .json({ error: "invite_not_found", message: "Invite code not found" });
          return;
        }
        const event = await openEvent(db, candidate.hackathonId);
        if (!event) {
          response.status(409).json({
            error: "registration_closed",
            message: "This event no longer accepts team changes",
          });
          return;
        }
        const session = db.client.startSession();
        let joined = false;
        try {
          await session.withTransaction(async () => {
            const registration = await db
              .collection<RegistrationDocument>(collections.registrations)
              .findOne(
                {
                  hackathonId: candidate.hackathonId,
                  personId: person._id,
                  teamId: { $exists: false },
                },
                { session },
              );
            if (!registration)
              throw new TeamConflictError("Apply to this event or leave your current team first");
            const updatedTeam = await db.collection<TeamDocument>(collections.teams).updateOne(
              {
                _id: candidate._id,
                status: "draft",
                memberIds: { $ne: person._id },
                $expr: { $lt: [{ $size: "$memberIds" }, event.teamSize.max] },
              },
              { $addToSet: { memberIds: person._id }, $set: { updatedAt: new Date() } },
              { session },
            );
            if (updatedTeam.modifiedCount !== 1)
              throw new TeamConflictError("Team is full, locked, or already joined");
            const attached = await db
              .collection<RegistrationDocument>(collections.registrations)
              .updateOne(
                { _id: registration._id, teamId: { $exists: false } },
                { $set: { teamId: candidate._id, lookingForTeam: false, updatedAt: new Date() } },
                { session },
              );
            if (attached.modifiedCount !== 1)
              throw new TeamConflictError("Team membership changed concurrently");
            joined = true;
          });
        } catch (error) {
          if (
            error instanceof TeamConflictError ||
            (error instanceof MongoServerError && error.code === 11000)
          ) {
            response.status(409).json({ error: "team_conflict", message: error.message });
            return;
          }
          throw error;
        } finally {
          await session.endSession();
        }
        if (!joined) throw new Error("Team was not joined");
        const team = await db
          .collection<TeamDocument>(collections.teams)
          .findOne({ _id: candidate._id });
        if (!team) throw new Error("Joined team disappeared");
        response.json({ team: await teamResponse(db, team) });
      });

      app.patch("/api/participant/team/looking-for-team", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const parsed = LookingForTeamSchema.safeParse(request.body);
        if (!parsed.success) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Invalid visibility choice" });
          return;
        }
        const updated = await db
          .collection<RegistrationDocument>(collections.registrations)
          .findOneAndUpdate(
            {
              personId: person._id,
              hackathonId: ObjectId.createFromHexString(parsed.data.eventId),
              teamId: { $exists: false },
            },
            { $set: { lookingForTeam: parsed.data.lookingForTeam, updatedAt: new Date() } },
            { returnDocument: "after" },
          );
        if (!updated) {
          response.status(409).json({
            error: "application_required",
            message: "No teamless application is available",
          });
          return;
        }
        response.json({ lookingForTeam: updated.lookingForTeam });
      });

      app.post("/api/participant/teams/:teamId/submit", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const teamId = request.params.teamId;
        if (!teamId || !ObjectId.isValid(teamId)) {
          response.status(404).json({ error: "team_not_found", message: "Team not found" });
          return;
        }
        const id = ObjectId.createFromHexString(teamId);
        const team = await db
          .collection<TeamDocument>(collections.teams)
          .findOne({ _id: id, captainId: person._id });
        if (!team) {
          response.status(404).json({ error: "team_not_found", message: "Team not found" });
          return;
        }
        const event = await openEvent(db, team.hackathonId);
        if (!event) {
          response
            .status(409)
            .json({ error: "registration_closed", message: "Registration is closed" });
          return;
        }
        if (
          team.memberIds.length < event.teamSize.min ||
          team.memberIds.length > event.teamSize.max
        ) {
          response.status(422).json({
            error: "invalid_team_size",
            message: `Teams must contain ${event.teamSize.min} to ${event.teamSize.max} members`,
          });
          return;
        }
        const readyPeople = await db
          .collection<ProfileDocument>(collections.profiles)
          .distinct("personId", { personId: { $in: team.memberIds }, status: "ready" });
        if (readyPeople.length !== team.memberIds.length) {
          response.status(422).json({
            error: "profiles_incomplete",
            message: "Every team member needs a completed evidence profile",
          });
          return;
        }
        const now = new Date();
        const session = db.client.startSession();
        try {
          await session.withTransaction(async () => {
            const locked = await db
              .collection<TeamDocument>(collections.teams)
              .updateOne(
                { _id: team._id, captainId: person._id, status: "draft" },
                { $set: { status: "submitted", submittedAt: now, updatedAt: now } },
                { session },
              );
            if (locked.modifiedCount !== 1)
              throw new TeamConflictError("Team is already submitted");
            await db
              .collection<RegistrationDocument>(collections.registrations)
              .updateMany(
                { hackathonId: team.hackathonId, personId: { $in: team.memberIds } },
                { $set: { status: "submitted", updatedAt: now } },
                { session },
              );
          });
        } catch (error) {
          if (error instanceof TeamConflictError) {
            response.status(409).json({ error: "team_conflict", message: error.message });
            return;
          }
          throw error;
        } finally {
          await session.endSession();
        }
        const submitted = await db
          .collection<TeamDocument>(collections.teams)
          .findOne({ _id: team._id });
        if (!submitted) throw new Error("Submitted team disappeared");
        response.json({ team: await teamResponse(db, submitted) });
      });

      app.post("/api/participant/teams/:teamId/invite/reset", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const teamId = request.params.teamId;
        if (!teamId || !ObjectId.isValid(teamId)) {
          response.status(404).json({ error: "team_not_found", message: "Team not found" });
          return;
        }
        const id = ObjectId.createFromHexString(teamId);
        const team = await db
          .collection<TeamDocument>(collections.teams)
          .findOne({ _id: id, captainId: person._id, status: "draft" });
        if (!team || !(await openEvent(db, team.hackathonId))) {
          response.status(409).json({
            error: "team_not_editable",
            message: "Only the captain can reset an invite before registration closes",
          });
          return;
        }
        let updated: TeamDocument | null = null;
        for (let attempt = 0; attempt < 5 && !updated; attempt += 1) {
          try {
            updated = await db
              .collection<TeamDocument>(collections.teams)
              .findOneAndUpdate(
                { _id: id, captainId: person._id, status: "draft" },
                { $set: { inviteCode: inviteCode(), updatedAt: new Date() } },
                { returnDocument: "after" },
              );
          } catch (error) {
            if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
          }
        }
        if (!updated) throw new Error("A unique invite code could not be generated");
        response.json({ team: await teamResponse(db, updated) });
      });

      app.delete("/api/participant/teams/:teamId/members/:memberId", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const teamId = request.params.teamId;
        const memberId = request.params.memberId;
        if (!teamId || !memberId || !ObjectId.isValid(teamId) || !ObjectId.isValid(memberId)) {
          response.status(404).json({ error: "team_not_found", message: "Team member not found" });
          return;
        }
        const id = ObjectId.createFromHexString(teamId);
        const removedPersonId = ObjectId.createFromHexString(memberId);
        if (removedPersonId.equals(person._id)) {
          response.status(422).json({
            error: "captain_must_leave",
            message: "Use leave team to transfer captaincy safely",
          });
          return;
        }
        const team = await db.collection<TeamDocument>(collections.teams).findOne({
          _id: id,
          captainId: person._id,
          status: "draft",
          memberIds: removedPersonId,
        });
        if (!team || !(await openEvent(db, team.hackathonId))) {
          response.status(409).json({
            error: "team_not_editable",
            message: "Only the captain can remove members before registration closes",
          });
          return;
        }
        const session = db.client.startSession();
        try {
          await session.withTransaction(async () => {
            const removed = await db
              .collection<TeamDocument>(collections.teams)
              .updateOne(
                { _id: id, captainId: person._id, status: "draft", memberIds: removedPersonId },
                { $pull: { memberIds: removedPersonId }, $set: { updatedAt: new Date() } },
                { session },
              );
            if (removed.modifiedCount !== 1)
              throw new TeamConflictError("Team membership changed concurrently");
            await db.collection<RegistrationDocument>(collections.registrations).updateOne(
              { hackathonId: team.hackathonId, personId: removedPersonId, teamId: id },
              {
                $unset: { teamId: "" },
                $set: { status: "draft", lookingForTeam: false, updatedAt: new Date() },
              },
              { session },
            );
          });
        } catch (error) {
          if (error instanceof TeamConflictError) {
            response.status(409).json({ error: "team_conflict", message: error.message });
            return;
          }
          throw error;
        } finally {
          await session.endSession();
        }
        const updated = await db.collection<TeamDocument>(collections.teams).findOne({ _id: id });
        if (!updated) throw new Error("Updated team disappeared");
        response.json({ team: await teamResponse(db, updated) });
      });

      app.post("/api/participant/teams/:teamId/leave", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const teamId = request.params.teamId;
        if (!teamId || !ObjectId.isValid(teamId)) {
          response.status(404).json({ error: "team_not_found", message: "Team not found" });
          return;
        }
        const id = ObjectId.createFromHexString(teamId);
        const team = await db
          .collection<TeamDocument>(collections.teams)
          .findOne({ _id: id, status: "draft", memberIds: person._id });
        if (!team || !(await openEvent(db, team.hackathonId))) {
          response.status(409).json({
            error: "team_not_editable",
            message: "Team members can leave only before registration closes",
          });
          return;
        }
        const remainingMembers = team.memberIds.filter((memberId) => !memberId.equals(person._id));
        const session = db.client.startSession();
        try {
          await session.withTransaction(async () => {
            if (remainingMembers.length === 0) {
              const deleted = await db
                .collection<TeamDocument>(collections.teams)
                .deleteOne({ _id: id, status: "draft", memberIds: person._id }, { session });
              if (deleted.deletedCount !== 1)
                throw new TeamConflictError("Team membership changed concurrently");
            } else {
              const nextCaptain = remainingMembers[0];
              if (!nextCaptain) throw new TeamConflictError("No member is available for captaincy");
              const update = team.captainId.equals(person._id)
                ? {
                    memberIds: remainingMembers,
                    captainId: nextCaptain,
                    updatedAt: new Date(),
                  }
                : { memberIds: remainingMembers, updatedAt: new Date() };
              const left = await db
                .collection<TeamDocument>(collections.teams)
                .updateOne(
                  { _id: id, status: "draft", memberIds: person._id },
                  { $set: update },
                  { session },
                );
              if (left.modifiedCount !== 1)
                throw new TeamConflictError("Team membership changed concurrently");
            }
            await db.collection<RegistrationDocument>(collections.registrations).updateOne(
              { hackathonId: team.hackathonId, personId: person._id, teamId: id },
              {
                $unset: { teamId: "" },
                $set: { status: "draft", lookingForTeam: false, updatedAt: new Date() },
              },
              { session },
            );
          });
        } catch (error) {
          if (error instanceof TeamConflictError) {
            response.status(409).json({ error: "team_conflict", message: error.message });
            return;
          }
          throw error;
        } finally {
          await session.endSession();
        }
        response.status(204).end();
      });
    },
  };
}
