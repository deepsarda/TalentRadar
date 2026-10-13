export interface PublicEvent {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  mode: "in_person" | "online" | "hybrid";
  venue?: string;
  registrationClosesAt: string;
  eventStartsAt: string;
  eventEndsAt: string;
  status: "upcoming" | "open" | "closed";
}

export interface ApiErrorShape {
  error: string;
  message: string;
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
