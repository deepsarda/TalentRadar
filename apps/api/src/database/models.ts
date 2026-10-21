import type {
  DecidedTeam,
  JudgmentDisagreement,
  PersonProfile,
  QuotaReport,
  QuotaRule,
  QuotaSwap,
  RankingParams,
  Requirement,
  SelectionOverride,
  SensitivityResult,
  Team,
} from "@talentradar/shared";
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
  city?: string;
  /** Absent after the participant revokes GitHub access. */
  encryptedAccessToken?: string;
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
  /** Consent to automated evaluation given outside an application (a standalone profile build). */
  profileConsentAt?: Date;
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
  /** Absent on assessments stored before rubric/sampler versions were recorded. */
  rubricVersion?: string;
  samplerVersion?: string;
  /** Absent means a primary assessment. A second opinion is merged with `basedOnAssessmentId`. */
  kind?: "primary" | "second_opinion";
  basedOnAssessmentId?: ObjectId;
  createdAt: Date;
}

export interface ProfileDocument extends Omit<PersonProfile, "personId"> {
  _id: ObjectId;
  personId: ObjectId;
  status: "pending" | "building" | "ready" | "failed";
  assessmentId?: ObjectId;
  /** Set once a second judge's assessment has been merged into this profile's skills. */
  secondAssessmentId?: ObjectId;
  /** How far the primary and second judge were apart, for the organizer's evidence view. */
  judgeDisagreement?: JudgmentDisagreement;
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
  quotas: QuotaRule[];
  collegeAliases: Record<string, string[]>;
  /** Per-event random salt for blind review pseudonymization. */
  blindSalt?: string;
  /**
   * The taxonomy the requirements' skill ids and the rubric their target levels refer to, set
   * from @talentradar/shared when requirements are written. Absent on older documents.
   */
  taxonomyVersion?: string;
  rubricVersion?: string;
  visibility: "draft" | "published" | "closed";
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}

export interface TeamDocument extends Omit<Team, "teamId" | "memberIds" | "submittedAt"> {
  _id: ObjectId;
  hackathonId: ObjectId;
  inviteCode: string;
  importKey?: string;
  /** A Quick Shortlist row with no team name, kept as a team of one so it gets an outcome. */
  unteamed?: boolean;
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
  cvFileId?: ObjectId;
  status:
    | "draft"
    | "submitted"
    | "under_review"
    | "selected"
    | "waitlisted"
    | "not_selected"
    | "confirmed"
    | "declined";
  /** Per-person RSVP deadline; set on selection and later for teams promoted off the waitlist. */
  rsvpDeadlineAt?: Date;
  promotedAt?: Date;
  /** Email outbox: the last status a notice was claimed for (see decision-api deliverNotices). */
  notifiedStatus?: RegistrationDocument["status"];
  createdAt: Date;
  updatedAt: Date;
}

export interface QuickImportDocument {
  _id: ObjectId;
  hackathonId: ObjectId;
  organizerId: ObjectId;
  csvFileId?: ObjectId;
  zipFileId?: ObjectId;
  headers: string[];
  rowCount: number;
  mapping?: Record<string, string>;
  status: "created" | "mapped" | "profiling" | "ready" | "failed";
  consentAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShortlistRunPersonSnapshot {
  personId: string;
  name: string;
  email?: string;
  github: string;
  verified: boolean;
  /** As entered, and as quotas saw it after the alias map. */
  college?: string;
  collegeNormalized?: string;
  year?: string;
  branch?: string;
  profileStatus: ProfileDocument["status"];
  /** The ready profile that was ranked; null when the person had none. */
  profile: {
    profileId: string;
    version: number;
    skills: PersonProfile["skills"];
    novelty: number;
    flags: PersonProfile["flags"];
    summary?: string;
    repos: ProfileDocument["repos"];
    taxonomyVersion: string;
    promptVersion?: string;
    model?: string;
    builtAt?: Date;
  } | null;
}

export interface ShortlistRunSnapshot {
  versions: { taxonomy: string; rubric?: string; prompts: string[] };
  teams: Array<Team & { unteamed?: boolean }>;
  people: ShortlistRunPersonSnapshot[];
}

export interface ShortlistRunDocument {
  _id: ObjectId;
  hackathonId: ObjectId;
  name: string;
  params: RankingParams;
  selection: {
    capacity: number;
    waitlistSize: number;
    quotas: QuotaRule[];
    selectedSeats: number;
    cutoffScore: number | null;
  };
  results: DecidedTeam[];
  swaps: QuotaSwap[];
  quotaReports: QuotaReport[];
  overrides: Array<SelectionOverride & { by: ObjectId; at: Date }>;
  /** The evidence the run was decided on, frozen at save. Absent on runs saved before it existed. */
  snapshot?: ShortlistRunSnapshot;
  published: boolean;
  publishedAt?: Date;
  /** Sensitivity analysis results. */
  sensitivity?: SensitivityResult;
  /** Post-event outcome ratings per team, set by organizers after the event ends. */
  outcomeRatings?: OutcomeRating[];
  createdBy: ObjectId;
  createdAt: Date;
}

export type JobType =
  | "fetch_repo"
  | "render_cv"
  | "judge_person"
  | "aggregate_profile"
  | "judge_second_opinion"
  | "import_row"
  | "prewarm_event_profiles";

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
  /** Unique when set: enqueueing the same key twice returns the existing job. */
  dedupeKey?: string;
  /** Set when the job is marked done; cleared once its follow-up (next stage) has run. */
  followUpPending?: boolean;
  followUpFailures?: number;
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

export type AuditAction =
  | "event.created"
  | "draft.saved"
  | "event.updated"
  | "event.published"
  | "event.unpublished"
  | "run.saved"
  | "run.published"
  | "override.added"
  | "second_opinion.requested"
  | "correction.resolved"
  | "correction.dismissed"
  | "outcome.rated";

/** Append-only: written with insertOne, never updated or deleted. */
export interface AuditEntryDocument {
  _id: ObjectId;
  hackathonId: ObjectId;
  actorId: ObjectId;
  action: AuditAction;
  /** Field-level summary, e.g. `capacity: 100 → 120`. */
  changes: string[];
  note?: string;
  at: Date;
}

export type CorrectionReason = "not_my_repo" | "missing_repo" | "level_off";

export interface CorrectionDocument {
  _id: ObjectId;
  personId: ObjectId;
  profileId: ObjectId;
  profileVersion: number;
  skill: string;
  reason: CorrectionReason;
  note?: string;
  status: "open" | "resolved" | "dismissed";
  resolution?: { by: ObjectId; at: Date; note?: string };
  createdAt: Date;
  updatedAt: Date;
}

/** 1–5 post-event outcome rating for one team in a shortlist run. */
export interface OutcomeRating {
  teamId: string;
  /** 1 = did not perform, 5 = standout performer */
  rating: 1 | 2 | 3 | 4 | 5;
  note?: string | undefined;
  by: ObjectId;
  at: Date;
}
