import { randomInt } from "node:crypto";
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
const LookingForTeamSchema = z.object({ lookingForTeam: z.boolean() });
const inviteAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

class TeamConflictError extends Error {}

function inviteCode(): string {
  return Array.from({ length: 8 }, () => inviteAlphabet[randomInt(inviteAlphabet.length)]).join("");
}

async function currentPerson(
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

export function createTeamApi(db: Db, authentication: Authentication): ApiModule {
  return {
    register(app: Express) {
      app.get("/api/participant/team", async (request, response) => {
        const person = await currentPerson(authentication, db, request, response);
        if (!person) return;
        const registration = await db
          .collection<RegistrationDocument>(collections.registrations)
          .find({ personId: person._id })
          .sort({ updatedAt: -1 })
          .limit(1)
          .next();
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
            { personId: person._id, teamId: { $exists: false } },
            { $set: { lookingForTeam: parsed.data.lookingForTeam, updatedAt: new Date() } },
            { sort: { updatedAt: -1 }, returnDocument: "after" },
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
