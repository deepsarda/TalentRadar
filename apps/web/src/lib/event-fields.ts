/** Event-form helpers shared by the event wizard, settings and quick-run promotion. */

export const timelineFields = [
  ["registrationOpensAt", "Registration opens"],
  ["registrationClosesAt", "Registration closes"],
  ["shortlistPublishesAt", "Shortlist published"],
  ["rsvpDeadlineAt", "RSVP deadline"],
  ["eventStartsAt", "Event starts"],
  ["eventEndsAt", "Event ends"],
] as const;
export type TimelineKey = (typeof timelineFields)[number][0];

/** Spec: lowercase a–z, 0–9 and hyphens, at most 40 characters. */
export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Timeline inputs are IST wall time (spec: entered in IST, stored in UTC). */
export function istDateTimeToIso(value: string): string {
  return new Date(`${value}:00+05:30`).toISOString();
}

export function isoToIstDateTime(value: string): string {
  const instant = new Date(value);
  return new Date(instant.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
