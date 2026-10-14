import type {
  DecidedTeam,
  PersonProfile,
  ProfileSkill,
  QuotaReport,
  QuotaRule,
  QuotaSwap,
  RankingParams,
  SelectionOverride,
  Team,
} from "@talentradar/shared";

export interface PublicEvent {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  registrationClosesAt: string;
  eventStartsAt: string;
  eventEndsAt: string;
  timezone: string;
  registrationOpensAt: string;
  shortlistPublishesAt: string;
  rsvpDeadlineAt: string;
  teamSize: { min: number; max: number };
  capacity: number;
  requirements: CreateEventInput["requirements"];
  links: Array<{ label: string; url: string }>;
  status: "upcoming" | "open" | "closed";
}

export interface ApiErrorShape {
  error: string;
  message: string;
}

export interface CurrentUser {
  id: string;
  githubId: number;
  login: string;
  name: string;
  email?: string;
  avatarUrl: string;
  roles: Array<"participant" | "organizer">;
}

export interface OrganizerEventSummary {
  id: string;
  kind: "event" | "quick";
  slug: string;
  name: string;
  visibility: "draft" | "published" | "closed";
  /** Drafts only: the first wizard step still needed before publishing. */
  missing?: "dates" | "requirements";
  registrationClosesAt?: string;
  eventStartsAt?: string;
  updatedAt: string;
}

export interface OrganizerEventDetails extends OrganizerEventSummary {
  tagline: string;
  logoUrl?: string;
  bannerUrl?: string;
  description: string;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  links: Array<{ label: string; url: string }>;
  capacity: number;
  teamSize: { min: number; max: number };
  requirements: CreateEventInput["requirements"];
  quotas: QuotaRule[];
  collegeAliases: Record<string, string[]>;
  metrics: { registrations: number; teams: number; profilesReady: number };
  timeline?: CreateEventInput["timeline"];
}

export interface OrganizerEventOperations {
  participants: Array<{
    registrationId: string;
    personId: string;
    name: string;
    github: string;
    email?: string;
    verified: boolean;
    college?: string;
    year?: string;
    branch?: string;
    status: ParticipantOverview["applications"][number]["status"];
    lookingForTeam: boolean;
    teamId?: string;
    profileStatus: "pending" | "building" | "ready" | "failed";
    profileVersion?: number;
    topSkills: string[];
    updatedAt: string;
  }>;
  teams: Array<{
    id: string;
    name: string;
    status: "draft" | "submitted" | "locked";
    captainId: string;
    submittedAt?: string;
    members: Array<{
      id: string;
      name: string;
      github: string;
      college?: string;
      profileStatus: "pending" | "building" | "ready" | "failed";
      topSkills: string[];
    }>;
  }>;
}

export interface EventConfigurationInput {
  name: string;
  tagline: string;
  description: string;
  links: Array<{ label: string; url: string }>;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  timeline: NonNullable<OrganizerEventDetails["timeline"]>;
  teamSize: { min: number; max: number };
  capacity: number;
  requirements: CreateEventInput["requirements"];
  quotas: QuotaRule[];
  collegeAliases: Record<string, string[]>;
}

export interface CreateEventInput {
  name: string;
  slug: string;
  tagline: string;
  description: string;
  logoUrl?: string;
  bannerUrl?: string;
  links: Array<{ label: string; url: string }>;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  timeline: {
    timezone: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
    shortlistPublishesAt: string;
    rsvpDeadlineAt: string;
    eventStartsAt: string;
    eventEndsAt: string;
  };
  teamSize: { min: number; max: number };
  capacity: number;
  requirements: Array<{
    skill: string;
    target: number;
    weight: number;
    coverage: { mode: "any_member" } | { mode: "min_members"; minMembers: number };
  }>;
  quotas: QuotaRule[];
  collegeAliases: Record<string, string[]>;
}

export interface RepositoryChoice {
  fullName: string;
  description?: string;
  url: string;
  defaultBranch: string;
  fork: boolean;
  sizeKb: number;
  pushedAt?: string;
  language?: string;
  eligible: boolean;
  exclusionReason?: string;
}

export interface ParticipantOverview {
  account: {
    name: string;
    login: string;
    college?: string;
    year?: string;
    branch?: string;
    hasCv: boolean;
    /** The stored CV in MongoDB GridFS, when there is one. */
    cv?: { name: string; size: number; uploadedAt: string };
  };
  profile: {
    status: "pending" | "building" | "ready" | "failed";
    version: number;
    summary?: string;
    /** Strongest first. */
    skills: Array<{ id: string; level: number; effective: number }>;
  } | null;
  applications: Array<{
    id: string;
    eventId: string;
    eventName: string;
    eventSlug?: string;
    status:
      | "draft"
      | "submitted"
      | "under_review"
      | "selected"
      | "waitlisted"
      | "not_selected"
      | "confirmed"
      | "declined";
    updatedAt: string;
  }>;
}

export interface ParticipantProfileResponse {
  profile: {
    id: string;
    version: number;
    status: "pending" | "building" | "ready" | "failed";
    displayName: string;
    repos: Array<{ fullName: string; sha?: string; included: boolean }>;
    skills: ProfileSkill[];
    novelty: number;
    flags: string[];
    summary?: string;
    taxonomyVersion: string;
    builtAt?: string;
    error?: string;
  };
  jobs: Array<{
    id: string;
    type: string;
    status: "queued" | "running" | "done" | "failed";
    attempts: number;
    progress: Array<{ at: string; code: string; message: string }>;
    error?: string;
  }>;
}

export interface ParticipantApplicationDetails {
  id: string;
  status: ParticipantOverview["applications"][number]["status"];
  lookingForTeam: boolean;
  teamId?: string;
  updatedAt: string;
  event: {
    id: string;
    slug: string;
    name: string;
    timeline: {
      registrationClosesAt: string;
      shortlistPublishesAt: string;
      rsvpDeadlineAt: string;
      eventStartsAt: string;
      timezone: string;
    } | null;
  };
}

export interface ParticipantTeam {
  id: string;
  hackathonId: string;
  name: string;
  inviteCode: string;
  captainId: string;
  status: "draft" | "submitted" | "locked";
  submittedAt?: string;
  members: Array<{
    id: string;
    name: string;
    github: string;
    profileStatus: "pending" | "building" | "ready" | "failed";
  }>;
}

export interface ParticipantTeamContext {
  registration: {
    id: string;
    lookingForTeam: boolean;
  };
  event: {
    id: string;
    name: string;
    teamSize: { min: number; max: number };
    registrationClosesAt?: string;
  };
  team: ParticipantTeam | null;
  personId: string;
}

export interface OrganizerShortlistTeam {
  teamId: string;
  name: string;
  memberIds: string[];
  members: Array<{
    personId: string;
    name: string;
    email?: string;
    github: string;
    college?: string;
    yearOfStudy?: string;
    branch?: string;
    profileStatus: "pending" | "building" | "ready" | "failed";
    topSkills: string[];
    flags: string[];
  }>;
}

export interface OrganizerShortlistData {
  event: {
    id: string;
    name: string;
    capacity: number;
    ranking: RankingParams;
    quotas: QuotaRule[];
  };
  profiles: PersonProfile[];
  teams: OrganizerShortlistTeam[];
  rankingTeams: Team[];
  unmappedColleges: string[];
  /** Per team: why it is ineligible beyond what rank() sees (e.g. no team in the import). */
  ineligibleNotes?: Record<string, string>;
  runs: Array<{
    id: string;
    name: string;
    published: boolean;
    selectedSeats: number;
    createdAt: string;
  }>;
}

export interface OrganizerShortlistRun {
  id: string;
  hackathonId: string;
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
  overrides: Array<SelectionOverride & { by: string; at: string }>;
  published: boolean;
  publishedAt?: string;
  createdAt: string;
  /** The evidence the run was decided on; null for runs saved before snapshots existed. */
  snapshot: ShortlistRunSnapshot | null;
}

export interface ShortlistRunPerson {
  personId: string;
  name: string;
  email?: string;
  github: string;
  verified: boolean;
  college?: string;
  collegeNormalized?: string;
  year?: string;
  branch?: string;
  profileStatus: "pending" | "building" | "ready" | "failed";
  profile: {
    profileId: string;
    version: number;
    skills: ProfileSkill[];
    novelty: number;
    flags: PersonProfile["flags"];
    summary?: string;
    taxonomyVersion: string;
    promptVersion?: string;
    model?: string;
    builtAt?: string;
  } | null;
}

export interface ShortlistRunSnapshot {
  versions: { taxonomy: string; rubric?: string; prompts: string[] };
  teams: Array<Team & { unteamed?: boolean }>;
  people: ShortlistRunPerson[];
}

export interface ProfileFailure {
  profileId: string;
  personId: string;
  name: string;
  github: string;
  error: string;
  jobs: Array<{ type: string; error: string }>;
}

export interface QuickCsvInspection {
  headers: string[];
  rowCount: number;
  suggestedMapping: Record<string, string>;
  preview: Array<Record<string, string>>;
}

export interface QuickImportStatus {
  id: string;
  name: string;
  status: "created" | "mapped" | "profiling" | "ready" | "failed";
  headers: string[];
  suggestedMapping: Record<string, string>;
  rowCount: number;
  hasCsv: boolean;
  hasArchive: boolean;
  mapping?: Record<string, string>;
  progress: { total: number; ready: number; failed: number; pending: number };
  failures: Array<{ personId: string; name: string; error: string }>;
  recentEvents: Array<{ at: string; message: string }>;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorShape | null;
    throw new ApiError(response.status, body?.message ?? `Request failed with ${response.status}`);
  }

  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

export async function getPublicEvents(): Promise<PublicEvent[]> {
  const response = await apiRequest<{ events: PublicEvent[] }>("/api/public/events");
  return response.events;
}

export async function getPublicEvent(slug: string): Promise<PublicEvent> {
  const response = await apiRequest<{ event: PublicEvent }>(`/api/public/events/${slug}`);
  return response.event;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const response = await apiRequest<{ user: CurrentUser }>("/api/me");
    return response.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function logout(): Promise<void> {
  await apiRequest<void>("/auth/logout", { method: "POST" });
}

export async function getOrganizerEvents(): Promise<OrganizerEventSummary[]> {
  const response = await apiRequest<{ events: OrganizerEventSummary[] }>("/api/organizer/events");
  return response.events;
}

export type EventDraftDetails = Pick<
  CreateEventInput,
  "name" | "slug" | "tagline" | "description" | "logoUrl" | "bannerUrl" | "links" | "mode" | "venue"
>;

/** One wizard step, validated and stored on its own. */
export type EventDraftStep =
  | ({ step: "details" } & EventDraftDetails)
  | { step: "dates"; timeline: CreateEventInput["timeline"] }
  | { step: "teams"; teamSize: CreateEventInput["teamSize"]; capacity: number }
  | { step: "requirements"; requirements: CreateEventInput["requirements"] }
  | { step: "quotas"; quotas: QuotaRule[]; collegeAliases: Record<string, string[]> };

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  changes: string[];
  note?: string;
  at: string;
}

export type CorrectionReason = "not_my_repo" | "missing_repo" | "level_off";

export interface OrganizerCorrection {
  id: string;
  personId: string;
  name: string;
  github: string;
  skill: string;
  reason: CorrectionReason;
  note?: string;
  profileVersion: number;
  createdAt: string;
}

export async function saveOrganizerEventDraft(
  eventId: string,
  input: EventDraftStep,
): Promise<OrganizerEventDetails> {
  const response = await apiRequest<{ event: OrganizerEventDetails }>(
    `/api/organizer/events/${eventId}/draft`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return response.event;
}

export async function unpublishOrganizerEvent(eventId: string): Promise<OrganizerEventSummary> {
  const response = await apiRequest<{ event: OrganizerEventSummary }>(
    `/api/organizer/events/${eventId}/unpublish`,
    { method: "POST" },
  );
  return response.event;
}

export async function getOrganizerEventAudit(eventId: string): Promise<AuditEntry[]> {
  const response = await apiRequest<{ entries: AuditEntry[] }>(
    `/api/organizer/events/${eventId}/audit`,
  );
  return response.entries;
}

export async function getOrganizerCorrections(eventId: string): Promise<OrganizerCorrection[]> {
  const response = await apiRequest<{ corrections: OrganizerCorrection[] }>(
    `/api/organizer/events/${eventId}/corrections`,
  );
  return response.corrections;
}

export async function resolveOrganizerCorrection(
  eventId: string,
  correctionId: string,
  input: { outcome: "resolved" | "dismissed"; note?: string },
): Promise<void> {
  await apiRequest(`/api/organizer/events/${eventId}/corrections/${correctionId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function reportProfileProblem(input: {
  skill: string;
  reason: CorrectionReason;
  note?: string;
}): Promise<void> {
  await apiRequest("/api/participant/profile/corrections", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Creates a draft from the details step; any later steps included are stored too. */
export async function createOrganizerEvent(
  input: EventDraftDetails & Partial<CreateEventInput>,
): Promise<OrganizerEventSummary> {
  const response = await apiRequest<{ event: OrganizerEventSummary }>("/api/organizer/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return response.event;
}

export async function getOrganizerEvent(eventId: string): Promise<OrganizerEventDetails> {
  const response = await apiRequest<{ event: OrganizerEventDetails }>(
    `/api/organizer/events/${eventId}`,
  );
  return response.event;
}

export async function publishOrganizerEvent(eventId: string): Promise<OrganizerEventSummary> {
  const response = await apiRequest<{ event: OrganizerEventSummary }>(
    `/api/organizer/events/${eventId}/publish`,
    { method: "POST" },
  );
  return response.event;
}

export async function getOrganizerEventOperations(
  eventId: string,
): Promise<OrganizerEventOperations> {
  return apiRequest(`/api/organizer/events/${eventId}/operations`);
}

export async function updateOrganizerEventConfiguration(
  eventId: string,
  input: EventConfigurationInput,
): Promise<OrganizerEventDetails> {
  const response = await apiRequest<{ event: OrganizerEventDetails }>(
    `/api/organizer/events/${eventId}/configuration`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return response.event;
}

export async function saveParticipantDetails(details: {
  name: string;
  college: string;
  year: string;
  branch: string;
}): Promise<void> {
  await apiRequest("/api/participant/details", { method: "PATCH", body: JSON.stringify(details) });
}

export async function getParticipantOverview(): Promise<ParticipantOverview> {
  return apiRequest<ParticipantOverview>("/api/participant/overview");
}

export async function getParticipantRepositories(): Promise<RepositoryChoice[]> {
  const response = await apiRequest<{ repositories: RepositoryChoice[] }>(
    "/api/participant/repositories",
  );
  return response.repositories;
}

export async function getParticipantProfile(): Promise<ParticipantProfileResponse> {
  return apiRequest("/api/participant/profile");
}

export async function getParticipantApplication(
  applicationId: string,
): Promise<ParticipantApplicationDetails> {
  const response = await apiRequest<{ application: ParticipantApplicationDetails }>(
    `/api/participant/applications/${applicationId}`,
  );
  return response.application;
}

/** Details found in the CV's text layer; a field is present only when the CV states it. */
export interface CvDetails {
  name?: string;
  college?: string;
  year?: string;
  branch?: string;
}

export async function uploadParticipantCv(
  file: File,
): Promise<{ cv: { id: string; name: string; size: number }; details: CvDetails }> {
  return apiRequest<{ cv: { id: string; name: string; size: number }; details: CvDetails }>(
    "/api/participant/cv",
    {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
}

/** Re-runs the profile build with the current CV and the last chosen repositories. */
/** Rebuild from the last choice, or (with repositories + consent) build without any event. */
export async function rebuildParticipantProfile(
  input: { repositories: string[]; consent: true } | Record<string, never> = {},
): Promise<{
  profile: { id: string; status: string; version: number; reused: boolean };
}> {
  return apiRequest("/api/participant/profile/rebuild", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Served as a JSON attachment, so a plain link downloads it. */
export const participantDataExportUrl = "/api/participant/data/export";

export async function revokeGithubAccess(): Promise<void> {
  await apiRequest<void>("/auth/github/revoke", { method: "POST" });
}

export async function deleteParticipantAccount(): Promise<{ githubRevoked: boolean }> {
  return apiRequest("/api/participant/data/delete", {
    method: "POST",
    body: JSON.stringify({ confirm: "delete" }),
  });
}

export async function submitParticipantApplication(
  slug: string,
  input: {
    details: { name: string; college: string; year: string; branch: string };
    repositories: string[];
    consent: true;
  },
): Promise<{
  application: { id: string; status: string };
  profile: { id: string; status: string; version: number };
}> {
  return apiRequest(`/api/participant/events/${slug}/applications`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getParticipantTeam(eventId: string): Promise<ParticipantTeamContext> {
  return apiRequest(`/api/participant/team?eventId=${encodeURIComponent(eventId)}`);
}

export async function createParticipantTeam(
  eventId: string,
  name: string,
): Promise<ParticipantTeam> {
  const response = await apiRequest<{ team: ParticipantTeam }>("/api/participant/teams", {
    method: "POST",
    body: JSON.stringify({ eventId, name }),
  });
  return response.team;
}

export async function joinParticipantTeam(inviteCode: string): Promise<ParticipantTeam> {
  const response = await apiRequest<{ team: ParticipantTeam }>("/api/participant/teams/join", {
    method: "POST",
    body: JSON.stringify({ inviteCode }),
  });
  return response.team;
}

export async function setParticipantLookingForTeam(
  eventId: string,
  lookingForTeam: boolean,
): Promise<boolean> {
  const response = await apiRequest<{ lookingForTeam: boolean }>(
    "/api/participant/team/looking-for-team",
    {
      method: "PATCH",
      body: JSON.stringify({ eventId, lookingForTeam }),
    },
  );
  return response.lookingForTeam;
}

export async function submitParticipantTeam(teamId: string): Promise<ParticipantTeam> {
  const response = await apiRequest<{ team: ParticipantTeam }>(
    `/api/participant/teams/${teamId}/submit`,
    { method: "POST" },
  );
  return response.team;
}

export async function resetParticipantTeamInvite(teamId: string): Promise<ParticipantTeam> {
  const response = await apiRequest<{ team: ParticipantTeam }>(
    `/api/participant/teams/${teamId}/invite/reset`,
    { method: "POST" },
  );
  return response.team;
}

export async function removeParticipantTeamMember(
  teamId: string,
  memberId: string,
): Promise<ParticipantTeam> {
  const response = await apiRequest<{ team: ParticipantTeam }>(
    `/api/participant/teams/${teamId}/members/${memberId}`,
    { method: "DELETE" },
  );
  return response.team;
}

export async function leaveParticipantTeam(teamId: string): Promise<void> {
  await apiRequest<void>(`/api/participant/teams/${teamId}/leave`, { method: "POST" });
}

export interface ParticipantRsvp {
  status: ParticipantApplicationDetails["status"];
  rsvpDeadlineAt: string | null;
  canRespond: boolean;
}

export async function getParticipantRsvp(applicationId: string): Promise<ParticipantRsvp> {
  const response = await apiRequest<{ rsvp: ParticipantRsvp }>(
    `/api/participant/applications/${applicationId}/rsvp`,
  );
  return response.rsvp;
}

export async function respondParticipantRsvp(
  applicationId: string,
  answer: "confirm" | "decline",
): Promise<ParticipantRsvp> {
  const response = await apiRequest<{ rsvp: ParticipantRsvp }>(
    `/api/participant/applications/${applicationId}/rsvp`,
    { method: "POST", body: JSON.stringify({ response: answer }) },
  );
  return response.rsvp;
}

export interface TeamFitRow {
  skill: string;
  target: number;
  level: number;
  best: { id: string; name: string } | null;
  covered: boolean;
}

export async function getParticipantTeamFit(teamId: string): Promise<TeamFitRow[]> {
  const response = await apiRequest<{ fit: TeamFitRow[] }>(`/api/participant/teams/${teamId}/fit`);
  return response.fit;
}

export interface TeammateSuggestion {
  id: string;
  name: string;
  github?: string;
  college?: string;
  topSkills: Array<{ id: string; level: number }>;
  fills: string[];
}

export async function getTeammateSuggestions(eventId: string): Promise<TeammateSuggestion[]> {
  const response = await apiRequest<{ suggestions: TeammateSuggestion[] }>(
    `/api/participant/teammates?eventId=${encodeURIComponent(eventId)}`,
  );
  return response.suggestions;
}

export async function getOrganizerShortlist(eventId: string): Promise<OrganizerShortlistData> {
  return apiRequest(`/api/organizer/events/${eventId}/shortlist`);
}

export async function saveOrganizerShortlistRun(
  eventId: string,
  input: {
    name: string;
    params: RankingParams;
    selection: {
      capacity: number;
      waitlistSize: number;
      quotas: QuotaRule[];
      overrides: SelectionOverride[];
    };
  },
): Promise<OrganizerShortlistRun> {
  const response = await apiRequest<{ run: OrganizerShortlistRun }>(
    `/api/organizer/events/${eventId}/shortlist/runs`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.run;
}

export async function publishOrganizerShortlistRun(
  eventId: string,
  runId: string,
): Promise<OrganizerShortlistRun> {
  const response = await apiRequest<{ run: OrganizerShortlistRun }>(
    `/api/organizer/events/${eventId}/shortlist/runs/${runId}/publish`,
    { method: "POST" },
  );
  return response.run;
}

export async function getOrganizerShortlistRun(
  eventId: string,
  runId: string,
): Promise<OrganizerShortlistRun> {
  const response = await apiRequest<{ run: OrganizerShortlistRun }>(
    `/api/organizer/events/${eventId}/shortlist/runs/${runId}`,
  );
  return response.run;
}

export async function createQuickImport(input: {
  name: string;
  teamSize: { min: number; max: number };
  capacity: number;
  requirements: CreateEventInput["requirements"];
}): Promise<{ id: string; name: string }> {
  const response = await apiRequest<{ quick: { id: string; name: string } }>(
    "/api/organizer/quick",
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.quick;
}

export async function uploadQuickCsv(quickId: string, file: File): Promise<QuickCsvInspection> {
  const response = await apiRequest<{ csv: QuickCsvInspection }>(
    `/api/organizer/quick/${quickId}/csv`,
    {
      method: "PUT",
      headers: { "content-type": "text/csv", "x-file-name": encodeURIComponent(file.name) },
      body: file,
    },
  );
  return response.csv;
}

export async function uploadQuickArchive(quickId: string, file: File): Promise<{ size: number }> {
  const response = await apiRequest<{ archive: { size: number } }>(
    `/api/organizer/quick/${quickId}/archive`,
    {
      method: "PUT",
      headers: { "content-type": "application/zip", "x-file-name": encodeURIComponent(file.name) },
      body: file,
    },
  );
  return response.archive;
}

export async function startQuickImport(
  quickId: string,
  mapping: Record<string, string | undefined>,
): Promise<{ id: string; rowsAccepted: number; rowsRejected: number; cvsMatched: number }> {
  const response = await apiRequest<{
    import: { id: string; rowsAccepted: number; rowsRejected: number; cvsMatched: number };
  }>(`/api/organizer/quick/${quickId}/start`, {
    method: "POST",
    body: JSON.stringify({ mapping, consent: true }),
  });
  return response.import;
}

export async function getProfileFailures(eventId: string): Promise<ProfileFailure[]> {
  const response = await apiRequest<{ failures: ProfileFailure[] }>(
    `/api/organizer/events/${eventId}/shortlist/failures`,
  );
  return response.failures;
}

export async function retryProfileFailure(eventId: string, profileId: string): Promise<void> {
  await apiRequest(`/api/organizer/events/${eventId}/shortlist/failures/${profileId}/retry`, {
    method: "POST",
  });
}

export interface PromoteQuickInput {
  slug: string;
  tagline: string;
  description: string;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  links?: Array<{ label: string; url: string }>;
  timeline: {
    timezone: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
    shortlistPublishesAt: string;
    rsvpDeadlineAt: string;
    eventStartsAt: string;
    eventEndsAt: string;
  };
}

export async function promoteQuickShortlist(
  quickId: string,
  input: PromoteQuickInput,
): Promise<{ id: string; slug: string }> {
  const response = await apiRequest<{ event: { id: string; slug: string } }>(
    `/api/organizer/quick/${quickId}/promote`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return response.event;
}

export async function getQuickImport(quickId: string): Promise<QuickImportStatus> {
  const response = await apiRequest<{ quick: QuickImportStatus }>(
    `/api/organizer/quick/${quickId}`,
  );
  return response.quick;
}
