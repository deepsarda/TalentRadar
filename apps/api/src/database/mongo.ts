import { type Db, MongoClient } from "mongodb";
import type {
  AssessmentDocument,
  AuditEntryDocument,
  CorrectionDocument,
  HackathonDocument,
  JobDocument,
  OAuthStateDocument,
  PersonDocument,
  ProfileDocument,
  QuickImportDocument,
  RegistrationDocument,
  SessionDocument,
  ShortlistRunDocument,
  TeamDocument,
  UserDocument,
} from "./models.js";

export const collections = {
  users: "users",
  people: "people",
  assessments: "assessments",
  profiles: "profiles",
  hackathons: "hackathons",
  teams: "teams",
  registrations: "registrations",
  shortlistRuns: "shortlist_runs",
  jobs: "jobs",
  sessions: "sessions",
  oauthStates: "oauth_states",
  quickImports: "quick_imports",
  auditEntries: "audit_entries",
  corrections: "corrections",
} as const;

export interface TalentRadarDatabase {
  db: Db;
  client: MongoClient;
}

export async function connectDatabase(uri: string): Promise<TalentRadarDatabase> {
  const client = new MongoClient(uri, {
    appName: "TalentRadar",
    maxPoolSize: 10,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10_000,
  });

  await client.connect();
  const db = client.db();
  await ensureIndexes(db);
  return { client, db };
}

export async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection<UserDocument>(collections.users).createIndexes([
      { key: { githubId: 1 }, name: "github_id_unique", unique: true },
      { key: { login: 1 }, name: "login_unique", unique: true },
    ]),
    db.collection<PersonDocument>(collections.people).createIndexes([
      {
        key: { userId: 1 },
        name: "user_person_unique",
        unique: true,
        partialFilterExpression: { userId: { $exists: true } },
      },
      {
        key: { importId: 1, importRow: 1 },
        name: "import_row_unique",
        unique: true,
        partialFilterExpression: { importId: { $exists: true }, importRow: { $exists: true } },
      },
    ]),
    db
      .collection<AssessmentDocument>(collections.assessments)
      .createIndex({ cacheKey: 1 }, { name: "assessment_cache_unique", unique: true }),
    db.collection<ProfileDocument>(collections.profiles).createIndexes([
      { key: { personId: 1, version: -1 }, name: "person_profile_version_unique", unique: true },
      { key: { personId: 1, status: 1 }, name: "person_profile_status" },
    ]),
    db
      .collection<HackathonDocument>(collections.hackathons)
      .createIndex({ slug: 1 }, { name: "hackathon_slug_unique", unique: true }),
    db.collection<TeamDocument>(collections.teams).createIndexes([
      { key: { inviteCode: 1 }, name: "team_invite_unique", unique: true },
      { key: { hackathonId: 1, memberIds: 1 }, name: "one_team_per_event_member", unique: true },
      {
        key: { hackathonId: 1, importKey: 1 },
        name: "quick_import_team_unique",
        unique: true,
        partialFilterExpression: { importKey: { $exists: true } },
      },
    ]),
    db
      .collection<RegistrationDocument>(collections.registrations)
      .createIndex(
        { hackathonId: 1, personId: 1 },
        { name: "registration_person_event_unique", unique: true },
      ),
    db.collection<ShortlistRunDocument>(collections.shortlistRuns).createIndexes([
      { key: { hackathonId: 1, createdAt: -1 }, name: "event_runs" },
      {
        key: { hackathonId: 1 },
        name: "one_published_run_per_event",
        unique: true,
        partialFilterExpression: { published: true },
      },
    ]),
    db.collection<QuickImportDocument>(collections.quickImports).createIndexes([
      { key: { hackathonId: 1 }, name: "quick_import_event_unique", unique: true },
      { key: { organizerId: 1, updatedAt: -1 }, name: "quick_import_organizer" },
    ]),
    db.collection<JobDocument>(collections.jobs).createIndexes([
      { key: { status: 1, runAt: 1 }, name: "job_claim" },
      { key: { status: 1, lockedUntil: 1 }, name: "job_lease_recovery" },
      { key: { "payload.profileId": 1, type: 1, status: 1 }, name: "profile_job_state" },
      {
        key: { dedupeKey: 1 },
        name: "job_dedupe_unique",
        unique: true,
        partialFilterExpression: { dedupeKey: { $type: "string" } },
      },
      {
        key: { completedAt: 1 },
        name: "job_follow_up_pending",
        partialFilterExpression: { followUpPending: true },
      },
    ]),
    db.collection<SessionDocument>(collections.sessions).createIndexes([
      { key: { expiresAt: 1 }, name: "session_expiry", expireAfterSeconds: 0 },
      { key: { userId: 1 }, name: "user_sessions" },
    ]),
    db
      .collection<OAuthStateDocument>(collections.oauthStates)
      .createIndex({ expiresAt: 1 }, { name: "oauth_state_expiry", expireAfterSeconds: 0 }),
    // sweepExpiredCvs (participants/data-api.ts) deletes files + chunks via GridFSBucket; a TTL
    // index here would orphan the chunks. These serve its uploadDate scan and per-person lookups.
    db.collection("cv.files").createIndexes([
      { key: { uploadDate: 1 }, name: "cv_retention_sweep" },
      { key: { "metadata.personId": 1 }, name: "cv_person" },
    ]),
    db
      .collection<RegistrationDocument>(collections.registrations)
      .createIndex({ cvFileId: 1 }, { name: "registration_cv", sparse: true }),
    db
      .collection<RegistrationDocument>(collections.registrations)
      .createIndex({ hackathonId: 1, status: 1 }, { name: "registration_event_status" }),
    db
      .collection<AuditEntryDocument>(collections.auditEntries)
      .createIndex({ hackathonId: 1, at: -1 }, { name: "event_audit" }),
    db
      .collection<CorrectionDocument>(collections.corrections)
      .createIndex({ personId: 1, status: 1, createdAt: -1 }, { name: "person_corrections" }),
  ]);
}
