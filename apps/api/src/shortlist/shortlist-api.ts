import {
  type PersonProfile,
  QuotaRuleSchema,
  type RankedTeam,
  RankingParamsSchema,
  rank,
  rubricVersion,
  type SelectionMember,
  type SelectionTeam,
  selectShortlist,
  type Team,
  taxonomyVersion,
} from "@talentradar/shared";
import type { Express, Request, Response } from "express";
import type { Db } from "mongodb";
import { MongoServerError, ObjectId } from "mongodb";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type {
  AssessmentDocument,
  HackathonDocument,
  JobDocument,
  PersonDocument,
  ProfileDocument,
  RegistrationDocument,
  ShortlistRunDocument,
  ShortlistRunPersonSnapshot,
  ShortlistRunSnapshot,
  TeamDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import { recordAudit } from "../events/audit.js";
import type { ApiModule } from "../events/organizer-events.js";
import { applyPublishedRun } from "../participants/decision-api.js";
import { normalizeCollege } from "./normalize-college.js";

const SelectionOverrideSchema = z.object({
  teamId: z.string().length(24),
  action: z.enum(["pin_in", "pin_out"]),
  reason: z.string().trim().min(3).max(500),
});

const SaveRunSchema = z.object({
  name: z.string().trim().min(2).max(100),
  params: RankingParamsSchema,
  selection: z.object({
    capacity: z.number().int().min(1).max(5000),
    waitlistSize: z.number().int().min(0).max(500),
    quotas: z.array(QuotaRuleSchema).max(20).default([]),
    overrides: z.array(SelectionOverrideSchema).max(1000).default([]),
  }),
});

/** Why a team is ineligible beyond what rank() can see; the client prepends the same notes. */
export const UNTEAMED_NOTE = "No team: registered without a team name";

/** Prepends each ineligible team's note to its reasons, so tables, explanations and CSV show it. */
export function withIneligibleNotes(
  ranked: RankedTeam[],
  notes: Readonly<Record<string, string>>,
): RankedTeam[] {
  return ranked.map((team) => {
    const note = notes[team.teamId];
    return note && !team.eligible
      ? { ...team, ineligibleReasons: [note, ...team.ineligibleReasons] }
      : team;
  });
}

interface ShortlistInput {
  profiles: PersonProfile[];
  rankingTeams: Team[];
  unmappedColleges: string[];
  ineligibleNotes: Record<string, string>;
  snapshot: ShortlistRunSnapshot;
  selectionTeams: Array<
    SelectionTeam & {
      members: Array<
        SelectionMember & {
          name: string;
          email?: string;
          github: string;
          profileStatus: ProfileDocument["status"];
          topSkills: string[];
          flags: string[];
        }
      >;
    }
  >;
}

function parseId(value: string | string[] | undefined): ObjectId | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && ObjectId.isValid(candidate) ? ObjectId.createFromHexString(candidate) : null;
}

function routeParam(request: Request, name: string): string | string[] | undefined {
  return request.params[name];
}

function serializeRun(run: ShortlistRunDocument) {
  return {
    id: run._id.toHexString(),
    hackathonId: run.hackathonId.toHexString(),
    name: run.name,
    params: run.params,
    selection: run.selection,
    results: run.results,
    swaps: run.swaps,
    quotaReports: run.quotaReports,
    overrides: run.overrides.map(({ by, at, ...override }) => ({
      ...override,
      by: by.toHexString(),
      at: at.toISOString(),
    })),
    snapshot: run.snapshot
      ? {
          ...run.snapshot,
          people: run.snapshot.people.map((person) => ({
            ...person,
            profile: person.profile
              ? { ...person.profile, builtAt: person.profile.builtAt?.toISOString() }
              : null,
          })),
        }
      : null,
    published: run.published,
    publishedAt: run.publishedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
  };
}

async function loadShortlistInput(db: Db, event: HackathonDocument): Promise<ShortlistInput> {
  const teamDocuments = await db
    .collection<TeamDocument>(collections.teams)
    .find({ hackathonId: event._id, status: { $in: ["submitted", "locked"] } })
    .sort({ submittedAt: 1, _id: 1 })
    .toArray();
  const personIds = [
    ...new Set(teamDocuments.flatMap((team) => team.memberIds.map((id) => id.toHexString()))),
  ].map((id) => ObjectId.createFromHexString(id));
  const [people, profileDocuments] = await Promise.all([
    personIds.length
      ? db
          .collection<PersonDocument>(collections.people)
          .find({ _id: { $in: personIds } })
          .toArray()
      : Promise.resolve([]),
    personIds.length
      ? db
          .collection<ProfileDocument>(collections.profiles)
          .find({ personId: { $in: personIds } })
          .sort({ personId: 1, version: -1 })
          .toArray()
      : Promise.resolve([]),
  ]);
  const peopleById = new Map(people.map((person) => [person._id.toHexString(), person]));
  const latestProfileByPerson = new Map<string, ProfileDocument>();
  for (const profile of profileDocuments) {
    const personId = profile.personId.toHexString();
    if (!latestProfileByPerson.has(personId)) latestProfileByPerson.set(personId, profile);
  }
  const assessmentIds = [...latestProfileByPerson.values()].flatMap((profile) =>
    profile.status === "ready" && profile.assessmentId ? [profile.assessmentId] : [],
  );
  const assessments = assessmentIds.length
    ? await db
        .collection<AssessmentDocument>(collections.assessments)
        .find({ _id: { $in: assessmentIds } }, { projection: { promptVersion: 1, model: 1 } })
        .toArray()
    : [];
  const assessmentById = new Map(
    assessments.map((assessment) => [assessment._id.toHexString(), assessment]),
  );
  const profiles = [...latestProfileByPerson.values()]
    .filter((profile) => profile.status === "ready")
    .map(
      (profile): PersonProfile => ({
        personId: profile.personId.toHexString(),
        displayName: profile.displayName,
        skills: profile.skills,
        novelty: profile.novelty,
        flags: profile.flags,
      }),
    );
  const rankingTeams = teamDocuments.flatMap((team): Team[] =>
    team.submittedAt
      ? [
          {
            teamId: team._id.toHexString(),
            name: team.name,
            memberIds: team.memberIds.map((id) => id.toHexString()),
            submittedAt: team.submittedAt.toISOString(),
          },
        ]
      : [],
  );
  const unmappedColleges = new Set<string>();
  const snapshotPeople: ShortlistRunPersonSnapshot[] = [];
  const selectionTeams = teamDocuments.flatMap((team): ShortlistInput["selectionTeams"] => {
    if (!team.submittedAt) return [];
    return [
      {
        teamId: team._id.toHexString(),
        name: team.name,
        memberIds: team.memberIds.map((id) => id.toHexString()),
        members: team.memberIds.map((id) => {
          const personId = id.toHexString();
          const person = peopleById.get(personId);
          const profile = latestProfileByPerson.get(personId);
          const college = person?.college
            ? normalizeCollege(person.college, event.collegeAliases)
            : undefined;
          if (college && !college.mapped) unmappedColleges.add(college.value);
          const ready = profile?.status === "ready" ? profile : undefined;
          const assessment = ready?.assessmentId
            ? assessmentById.get(ready.assessmentId.toHexString())
            : undefined;
          snapshotPeople.push({
            personId,
            name: person?.name ?? "Deleted participant",
            ...(person?.email ? { email: person.email } : {}),
            github: person?.github ?? "unavailable",
            verified: person?.verified ?? false,
            ...(person?.college ? { college: person.college } : {}),
            ...(college ? { collegeNormalized: college.value } : {}),
            ...(person?.year ? { year: person.year } : {}),
            ...(person?.branch ? { branch: person.branch } : {}),
            profileStatus: profile?.status ?? "pending",
            profile: ready
              ? {
                  profileId: ready._id.toHexString(),
                  version: ready.version,
                  skills: ready.skills,
                  novelty: ready.novelty,
                  flags: ready.flags,
                  repos: ready.repos,
                  taxonomyVersion: ready.taxonomyVersion,
                  ...(assessment?.promptVersion ? { promptVersion: assessment.promptVersion } : {}),
                  ...(assessment?.model ? { model: assessment.model } : {}),
                  ...(ready.builtAt ? { builtAt: ready.builtAt } : {}),
                }
              : null,
          });
          return {
            personId,
            name: person?.name ?? "Deleted participant",
            ...(person?.email ? { email: person.email } : {}),
            github: person?.github ?? "unavailable",
            ...(college ? { college: college.value } : {}),
            ...(person?.year ? { yearOfStudy: person.year } : {}),
            ...(person?.branch ? { branch: person.branch } : {}),
            profileStatus: profile?.status ?? "pending",
            topSkills: profile?.skills.slice(0, 3).map((skill) => skill.id) ?? [],
            flags: profile?.flags ?? [],
          };
        }),
      },
    ];
  });
  const unteamed = new Set(
    teamDocuments.flatMap((team) => (team.unteamed ? [team._id.toHexString()] : [])),
  );
  return {
    profiles,
    rankingTeams,
    selectionTeams,
    unmappedColleges: [...unmappedColleges].sort((left, right) => left.localeCompare(right)),
    ineligibleNotes: Object.fromEntries([...unteamed].map((teamId) => [teamId, UNTEAMED_NOTE])),
    snapshot: {
      versions: {
        taxonomy: taxonomyVersion,
        rubric: rubricVersion,
        prompts: [
          ...new Set(
            snapshotPeople.flatMap((person) =>
              person.profile?.promptVersion ? [person.profile.promptVersion] : [],
            ),
          ),
        ].sort(),
      },
      teams: rankingTeams.map((team) => ({
        ...team,
        ...(unteamed.has(team.teamId) ? { unteamed: true } : {}),
      })),
      people: snapshotPeople,
    },
  };
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createShortlistApi(db: Db, authentication: Authentication): ApiModule {
  async function ownedEvent(
    request: Request,
    response: Response,
  ): Promise<{ organizerId: ObjectId; event: HackathonDocument } | null> {
    const user = await authentication.currentUser(request);
    if (!user) {
      response.status(401).json({
        error: "authentication_required",
        message: "Sign in with GitHub to use the organizer console",
      });
      return null;
    }
    const organizerId = ObjectId.createFromHexString(user.id);
    const eventId = parseId(routeParam(request, "eventId"));
    if (!eventId) {
      response.status(404).json({ error: "event_not_found", message: "Event not found" });
      return null;
    }
    const event = await db
      .collection<HackathonDocument>(collections.hackathons)
      .findOne({ _id: eventId, organizerIds: organizerId });
    if (!event) {
      response.status(404).json({ error: "event_not_found", message: "Event not found" });
      return null;
    }
    return { organizerId, event };
  }

  return {
    register(app: Express) {
      app.get("/api/organizer/events/:eventId/shortlist", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const [input, runs] = await Promise.all([
          loadShortlistInput(db, owned.event),
          db
            .collection<ShortlistRunDocument>(collections.shortlistRuns)
            .find({ hackathonId: owned.event._id })
            .sort({ createdAt: -1 })
            .limit(100)
            .toArray(),
        ]);
        response.json({
          event: {
            id: owned.event._id.toHexString(),
            name: owned.event.name,
            capacity: owned.event.capacity,
            ranking: owned.event.ranking,
            quotas: owned.event.quotas,
          },
          profiles: input.profiles,
          teams: input.selectionTeams,
          rankingTeams: input.rankingTeams,
          unmappedColleges: input.unmappedColleges,
          ineligibleNotes: input.ineligibleNotes,
          runs: runs.map((run) => ({
            id: run._id.toHexString(),
            name: run.name,
            published: run.published,
            selectedSeats: run.selection.selectedSeats,
            createdAt: run.createdAt.toISOString(),
          })),
        });
      });

      app.post("/api/organizer/events/:eventId/shortlist/runs", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const parsed = SaveRunSchema.safeParse(request.body);
        if (!parsed.success) {
          response
            .status(422)
            .json({ error: "validation_failed", message: "Run parameters are invalid" });
          return;
        }
        // Drafts are saved step by step, so requirements can still be empty here.
        if (owned.event.ranking.requirements.length === 0) {
          response.status(409).json({
            error: "requirements_missing",
            message: "Add requirements to this event before saving a run",
          });
          return;
        }
        const input = await loadShortlistInput(db, owned.event);
        if (input.rankingTeams.length === 0) {
          response.status(409).json({
            error: "no_submitted_teams",
            message: "No submitted teams with completed rosters are available to rank",
          });
          return;
        }
        const ranked = withIneligibleNotes(
          rank(input.profiles, input.rankingTeams, parsed.data.params),
          input.ineligibleNotes,
        );
        const decision = selectShortlist(ranked, input.selectionTeams, {
          capacity: parsed.data.selection.capacity,
          waitlistSize: parsed.data.selection.waitlistSize,
          quotas: parsed.data.selection.quotas,
          overrides: parsed.data.selection.overrides,
        });
        const now = new Date();
        const document: Omit<ShortlistRunDocument, "_id"> = {
          hackathonId: owned.event._id,
          name: parsed.data.name,
          params: parsed.data.params,
          selection: {
            capacity: parsed.data.selection.capacity,
            waitlistSize: parsed.data.selection.waitlistSize,
            quotas: parsed.data.selection.quotas,
            selectedSeats: decision.selectedSeats,
            cutoffScore: decision.cutoffScore,
          },
          results: decision.results,
          swaps: decision.swaps,
          quotaReports: decision.quotaReports,
          overrides: parsed.data.selection.overrides.map((override) => ({
            ...override,
            by: owned.organizerId,
            at: now,
          })),
          snapshot: input.snapshot,
          published: false,
          createdBy: owned.organizerId,
          createdAt: now,
        };
        const inserted = await db
          .collection<ShortlistRunDocument>(collections.shortlistRuns)
          .insertOne(document as ShortlistRunDocument);
        await recordAudit(db, {
          hackathonId: owned.event._id,
          actorId: owned.organizerId,
          action: "run.saved",
          changes: [document.name],
        });
        for (const override of parsed.data.selection.overrides) {
          await recordAudit(db, {
            hackathonId: owned.event._id,
            actorId: owned.organizerId,
            action: "override.added",
            changes: [
              `${decision.results.find((result) => result.teamId === override.teamId)?.name ?? override.teamId}: ${override.action.replace("_", " ")}`,
            ],
            note: override.reason,
          });
        }
        response.status(201).json({ run: serializeRun({ ...document, _id: inserted.insertedId }) });
      });

      // Registered before the plain run route, which would otherwise capture `<id>.csv`.
      app.get(
        "/api/organizer/events/:eventId/shortlist/runs/:runId.csv",
        async (request, response) => {
          const owned = await ownedEvent(request, response);
          if (!owned) return;
          const runId = parseId(request.params.runId);
          const run = runId
            ? await db
                .collection<ShortlistRunDocument>(collections.shortlistRuns)
                .findOne({ _id: runId, hackathonId: owned.event._id })
            : null;
          if (!run) {
            response
              .status(404)
              .json({ error: "run_not_found", message: "Shortlist run not found" });
            return;
          }
          // Only the frozen snapshot: an export must not change when a live profile does.
          const peopleById = new Map(
            (run.snapshot?.people ?? []).map((person) => [person.personId, person]),
          );
          const header = [
            "Team",
            "Name",
            "Email",
            "College",
            "Status",
            "Rank",
            "Team score",
            "Top skills",
            "Reasons",
          ];
          const rows = run.results.flatMap((result) =>
            result.memberIds.map((personId) => {
              const person = peopleById.get(personId);
              return [
                result.name,
                person?.name ?? "Not in run snapshot",
                person?.email ?? "",
                person?.college ?? "",
                result.status,
                result.rank ?? "",
                result.score.toFixed(2),
                person?.profile?.skills
                  .slice(0, 3)
                  .map((skill) => skill.id)
                  .join("; ") ?? "",
                result.ineligibleReasons.join("; "),
              ];
            }),
          );
          const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
          response.setHeader("content-type", "text/csv; charset=utf-8");
          response.setHeader(
            "content-disposition",
            `attachment; filename="${owned.event.slug}-${run.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv"`,
          );
          response.send(csv);
        },
      );

      app.get("/api/organizer/events/:eventId/shortlist/runs/:runId", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const runId = parseId(request.params.runId);
        const run = runId
          ? await db
              .collection<ShortlistRunDocument>(collections.shortlistRuns)
              .findOne({ _id: runId, hackathonId: owned.event._id })
          : null;
        if (!run) {
          response.status(404).json({ error: "run_not_found", message: "Shortlist run not found" });
          return;
        }
        response.json({ run: serializeRun(run) });
      });

      app.post(
        "/api/organizer/events/:eventId/shortlist/runs/:runId/publish",
        async (request, response) => {
          const owned = await ownedEvent(request, response);
          if (!owned) return;
          const runId = parseId(request.params.runId);
          if (!runId) {
            response
              .status(404)
              .json({ error: "run_not_found", message: "Shortlist run not found" });
            return;
          }
          if (owned.event.timeline && owned.event.timeline.registrationClosesAt > new Date()) {
            response.status(409).json({
              error: "registration_open",
              message: "The final shortlist cannot be published before registration closes",
            });
            return;
          }
          const runs = db.collection<ShortlistRunDocument>(collections.shortlistRuns);
          const [run, existingFinal] = await Promise.all([
            runs.findOne({ _id: runId, hackathonId: owned.event._id }),
            runs.findOne({ hackathonId: owned.event._id, published: true }),
          ]);
          if (!run) {
            response
              .status(404)
              .json({ error: "run_not_found", message: "Shortlist run not found" });
            return;
          }
          if (existingFinal && !existingFinal._id.equals(run._id)) {
            response.status(409).json({
              error: "final_run_exists",
              message: "This event already has a published final shortlist",
            });
            return;
          }
          if (run.published) {
            response.json({ run: serializeRun(run) });
            return;
          }
          const now = new Date();
          const session = db.client.startSession();
          try {
            // The one_published_run_per_event index rejects a second published run, so two
            // concurrent publishes of different runs cannot both pass the check above.
            await session.withTransaction(async () => {
              // Registration statuses, RSVP deadlines and emails: applyPublishedRun, after commit.
              for (const result of run.results) {
                const teamId = ObjectId.createFromHexString(result.teamId);
                await db
                  .collection<TeamDocument>(collections.teams)
                  .updateOne(
                    { _id: teamId },
                    { $set: { status: "locked", updatedAt: now } },
                    { session },
                  );
              }
              await runs.updateOne(
                { _id: run._id, published: false },
                { $set: { published: true, publishedAt: now } },
                { session },
              );
              await db
                .collection<HackathonDocument>(collections.hackathons)
                .updateOne(
                  { _id: owned.event._id },
                  { $set: { visibility: "closed", updatedAt: now } },
                  { session },
                );
            });
          } catch (error) {
            if (error instanceof MongoServerError && error.code === 11000) {
              response.status(409).json({
                error: "final_run_exists",
                message: "This event already has a published final shortlist",
              });
              return;
            }
            throw error;
          } finally {
            await session.endSession();
          }
          await applyPublishedRun(db, run._id, now);
          const published = await runs.findOne({ _id: run._id });
          if (!published) throw new Error("Published run disappeared");
          await recordAudit(db, {
            hackathonId: owned.event._id,
            actorId: owned.organizerId,
            action: "run.published",
            changes: [published.name],
          });
          response.json({ run: serializeRun(published) });
        },
      );

      // Failed profile builds for this event's people, with the error, so the organizer can
      // retry them before trusting a ranking that silently left those people out.
      app.get("/api/organizer/events/:eventId/shortlist/failures", async (request, response) => {
        const owned = await ownedEvent(request, response);
        if (!owned) return;
        const registrations = await db
          .collection<RegistrationDocument>(collections.registrations)
          .find({ hackathonId: owned.event._id }, { projection: { personId: 1 } })
          .toArray();
        const personIds = registrations.map((registration) => registration.personId);
        const profiles = personIds.length
          ? await db
              .collection<ProfileDocument>(collections.profiles)
              .find({ personId: { $in: personIds } })
              .sort({ personId: 1, version: -1 })
              .toArray()
          : [];
        const latest = new Map<string, ProfileDocument>();
        for (const profile of profiles) {
          const personId = profile.personId.toHexString();
          if (!latest.has(personId)) latest.set(personId, profile);
        }
        const failed = [...latest.values()].filter((profile) => profile.status === "failed");
        const [people, jobs] = failed.length
          ? await Promise.all([
              db
                .collection<PersonDocument>(collections.people)
                .find({ _id: { $in: failed.map((profile) => profile.personId) } })
                .toArray(),
              db
                .collection<JobDocument>(collections.jobs)
                .find({
                  "payload.profileId": { $in: failed.map((profile) => profile._id.toHexString()) },
                  status: "failed",
                })
                .toArray(),
            ])
          : [[], []];
        const personById = new Map(people.map((person) => [person._id.toHexString(), person]));
        response.json({
          failures: failed.map((profile) => {
            const person = personById.get(profile.personId.toHexString());
            const profileId = profile._id.toHexString();
            return {
              profileId,
              personId: profile.personId.toHexString(),
              name: person?.name ?? profile.displayName,
              github: person?.github ?? "",
              error: profile.error ?? "Profile build failed",
              jobs: jobs
                .filter(({ payload: { profileId: jobProfileId } }) => jobProfileId === profileId)
                .map((job) => ({ type: job.type, error: job.error ?? "Job failed" })),
            };
          }),
        });
      });

      app.post(
        "/api/organizer/events/:eventId/shortlist/failures/:profileId/retry",
        async (request, response) => {
          const owned = await ownedEvent(request, response);
          if (!owned) return;
          const profileId = parseId(request.params.profileId);
          const profile = profileId
            ? await db
                .collection<ProfileDocument>(collections.profiles)
                .findOne({ _id: profileId, status: "failed" })
            : null;
          const registered = profile
            ? await db
                .collection<RegistrationDocument>(collections.registrations)
                .findOne({ hackathonId: owned.event._id, personId: profile.personId })
            : null;
          if (!profile || !registered) {
            response
              .status(404)
              .json({ error: "failure_not_found", message: "No failed profile to retry" });
            return;
          }
          const now = new Date();
          let retried = 0;
          const session = db.client.startSession();
          try {
            await session.withTransaction(async () => {
              const requeued = await db.collection<JobDocument>(collections.jobs).updateMany(
                { "payload.profileId": profile._id.toHexString(), status: "failed" },
                {
                  $set: { status: "queued", attempts: 0, runAt: now, updatedAt: now },
                  $unset: { error: "", completedAt: "" },
                  $push: {
                    progress: {
                      $each: [{ at: now, code: "job.retried", message: "Organizer retried" }],
                      $slice: -200,
                    },
                  },
                },
                { session },
              );
              retried = requeued.modifiedCount;
              if (retried === 0) return;
              await db
                .collection<ProfileDocument>(collections.profiles)
                .updateOne(
                  { _id: profile._id, status: "failed" },
                  { $set: { status: "pending", updatedAt: now }, $unset: { error: "" } },
                  { session },
                );
            });
          } finally {
            await session.endSession();
          }
          if (retried === 0) {
            response.status(409).json({
              error: "nothing_to_retry",
              message: "This profile has no failed job to retry",
            });
            return;
          }
          response.json({ retried });
        },
      );
    },
  };
}
