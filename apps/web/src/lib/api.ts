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
  slug: string;
  name: string;
  visibility: "draft" | "published" | "closed";
  registrationClosesAt?: string;
  eventStartsAt?: string;
  updatedAt: string;
}

export interface OrganizerEventDetails extends OrganizerEventSummary {
  tagline: string;
  description: string;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  capacity: number;
  teamSize: { min: number; max: number };
  requirements: CreateEventInput["requirements"];
  metrics: { registrations: number; teams: number; profilesReady: number };
  timeline?: CreateEventInput["timeline"];
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
  };
  profile: { status: "pending" | "building" | "ready" | "failed"; version: number } | null;
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

export async function createOrganizerEvent(
  input: CreateEventInput,
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

export async function uploadParticipantCv(
  file: File,
): Promise<{ id: string; name: string; size: number }> {
  const response = await apiRequest<{ cv: { id: string; name: string; size: number } }>(
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
  return response.cv;
}

export async function submitParticipantApplication(
  slug: string,
  input: {
    details: { name: string; college: string; year: string; branch: string };
    repositories: string[];
    consent: true;
    syntheticCv: boolean;
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

export async function getRuntimeConfig(): Promise<{
  modelDataPolicy: "synthetic_only" | "paid_private";
}> {
  return apiRequest("/api/config");
}
import type { ProfileSkill } from "@talentradar/shared";
