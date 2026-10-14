import type { PersonProfile, RankingParams, Requirement, Team } from "@talentradar/shared";
import type { ObjectId } from "mongodb";

export type AccountRole = "participant" | "organizer";

export interface UserDocument {
  _id: ObjectId;
  githubId: number;
  login: string;
  name: string;
  email?: string;
  avatarUrl: string;
  roles: AccountRole[];
  college?: string;
  year?: string;
  branch?: string;
  encryptedAccessToken: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date;
}

export interface PersonDocument {
  _id: ObjectId;
  userId?: ObjectId;
  importId?: ObjectId;
  importRow?: number;
  name: string;
  email?: string;
  github: string;
  verified: boolean;
  college?: string;
  year?: string;
  branch?: string;
  currentCvFileId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssessmentDocument {
  _id: ObjectId;
  cacheKey: string;
  personId: ObjectId;
  facts: unknown;
  cvLinks: string[];
  result: unknown;
  model: string;
  promptVersion: string;
  taxonomyVersion: string;
  createdAt: Date;
}

export interface ProfileDocument extends Omit<PersonProfile, "personId"> {
  _id: ObjectId;
  personId: ObjectId;
  status: "pending" | "building" | "ready" | "failed";
  assessmentId?: ObjectId;
  version: number;
  repos: Array<{ fullName: string; sha?: string; included: boolean }>;
  builtAt?: Date;
  error?: string;
  taxonomyVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HackathonTimelineDocument {
  timezone: string;
  registrationOpensAt: Date;
  registrationClosesAt: Date;
  shortlistPublishesAt: Date;
  rsvpDeadlineAt: Date;
  eventStartsAt: Date;
  eventEndsAt: Date;
}

export interface HackathonDocument {
  _id: ObjectId;
  kind: "event" | "quick";
  slug: string;
  name: string;
  tagline: string;
  description: string;
  logoUrl?: string;
  bannerUrl?: string;
  links: Array<{ label: string; url: string }>;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  organizerIds: ObjectId[];
  timeline?: HackathonTimelineDocument;
  teamSize: { min: number; max: number };
  capacity: number;
  requirements: Requirement[];
  ranking: RankingParams;
  quotas: unknown[];
  collegeAliases: Record<string, string[]>;
  visibility: "draft" | "published" | "closed";
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}

export interface TeamDocument extends Omit<Team, "teamId" | "memberIds" | "submittedAt"> {
  _id: ObjectId;
  hackathonId: ObjectId;
  inviteCode: string;
  captainId: ObjectId;
  memberIds: ObjectId[];
  status: "draft" | "submitted" | "locked";
  submittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegistrationDocument {
  _id: ObjectId;
  hackathonId: ObjectId;
  personId: ObjectId;
  teamId?: ObjectId;
  lookingForTeam: boolean;
  consentAt: Date;
  selectedRepositories: string[];
  cvFileId: ObjectId;
  status:
    | "draft"
    | "submitted"
    | "under_review"
    | "selected"
    | "waitlisted"
    | "not_selected"
    | "confirmed"
    | "declined";
  createdAt: Date;
  updatedAt: Date;
}

export interface ShortlistRunDocument {
  _id: ObjectId;
  hackathonId: ObjectId;
  name: string;
  params: RankingParams;
  results: unknown[];
  overrides: Array<{
    teamId: ObjectId;
    action: "pin_in" | "pin_out";
    reason: string;
    by: ObjectId;
    at: Date;
  }>;
  published: boolean;
  publishedAt?: Date;
  createdBy: ObjectId;
  createdAt: Date;
}

export type JobType =
  | "fetch_repo"
  | "render_cv"
  | "judge_person"
  | "aggregate_profile"
  | "import_row";

export interface JobProgressEvent {
  at: Date;
  code: string;
  message: string;
}

export interface JobDocument {
  _id?: ObjectId;
  type: JobType;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  lockedUntil?: Date;
  lockedBy?: string;
  runAt: Date;
  error?: string;
  progress: JobProgressEvent[];
  result?: Record<string, unknown>;
  partialThoughts?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface SessionDocument {
  _id: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface OAuthStateDocument {
  _id: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: Date;
  expiresAt: Date;
}
