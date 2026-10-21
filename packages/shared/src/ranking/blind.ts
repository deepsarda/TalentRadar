import type { PersonProfile } from "../schemas.js";
import type { DecidedTeam } from "./select.js";

const ADJECTIVES = [
  "Amber",
  "Bravo",
  "Cobalt",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golden",
  "Helix",
  "Indigo",
  "Jade",
  "Krypton",
  "Lunar",
  "Matrix",
  "Nova",
  "Omega",
  "Prism",
  "Quantum",
  "Radiant",
  "Solar",
  "Titan",
  "Ultra",
  "Vector",
  "Zenith",
];

const NOUNS = [
  "Apex",
  "Beacon",
  "Cipher",
  "Dynamo",
  "Eclipse",
  "Falcon",
  "Glider",
  "Horizon",
  "Impulse",
  "Javelin",
  "Kestrel",
  "Lumen",
  "Mirage",
  "Nebula",
  "Orion",
  "Pioneer",
  "Quasar",
  "Raptor",
  "Specter",
  "Torrent",
  "Vanguard",
  "Wraith",
  "Zenon",
];

/** Fast, deterministic 32-bit FNV-1a hash for browser & Node environments without crypto dependency. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically generates a pseudonymous team name from its teamId and salt.
 * e.g., "Team Amber Falcon"
 */
export function pseudonymizeTeamName(teamId: string, salt = ""): string {
  const h1 = fnv1a(`${teamId}:${salt}:adj`);
  const h2 = fnv1a(`${teamId}:${salt}:noun`);
  const adj = ADJECTIVES[h1 % ADJECTIVES.length] ?? "Apex";
  const noun = NOUNS[h2 % NOUNS.length] ?? "Falcon";
  return `Team ${adj} ${noun}`;
}

/**
 * Deterministically generates an anonymous applicant label from a personId.
 * Uses two FNV-1a hashes combined for 8 hex characters, giving 4 billion distinct IDs
 * so a 5000-person event has a collision probability below one in a million.
 * e.g., "Candidate #A4F2B83C"
 */
export function pseudonymizePersonName(personId: string, salt = ""): string {
  // Use 64-bit FNV-1a style by combining two independent seeds into two 32-bit halves
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const input = `${personId}:${salt}:candidate`;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code;
    h2 = Math.imul(h2, 0x27d4eb2d);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  const fullHex = `${hex1}${hex2}`.toUpperCase();
  return `Candidate #${fullHex.slice(0, 12)}`;
}

/**
 * Redacted person profile for blind evaluation:
 * - Replaces displayName with deterministic 8-hex-char pseudonym
 * - Replaces summary entirely (prevents college/GitHub leakage through free text)
 */
export function redactProfileForBlindReview(profile: PersonProfile, salt = ""): PersonProfile {
  return {
    ...profile,
    displayName: pseudonymizePersonName(profile.personId, salt),
    summary: profile.summary ? "[Profile summary hidden in Blind Evaluation mode]" : undefined,
  };
}

/**
 * Redacted decided team for blind evaluation:
 * - Replaces team name with pseudonym
 */
export function redactTeamForBlindReview(team: DecidedTeam, salt = ""): DecidedTeam {
  return {
    ...team,
    name: pseudonymizeTeamName(team.teamId, salt),
  };
}

/**
 * Strips identifying fields from a shortlist-run person snapshot for blind review.
 * Removes: github handle, email address, college, and normalized college.
 */
export function redactSnapshotPersonForBlindReview<
  T extends { github?: string; email?: string; college?: string; collegeNormalized?: string },
>(
  person: T,
  salt: string,
  personId: string,
): Omit<T, "github" | "email" | "college" | "collegeNormalized"> & { displayName: string } {
  const {
    github: _g,
    email: _e,
    college: _c,
    collegeNormalized: _cn,
    ...rest
  } = person as Record<string, unknown>;
  return { ...rest, displayName: pseudonymizePersonName(personId, salt) } as Omit<
    T,
    "github" | "email" | "college" | "collegeNormalized"
  > & { displayName: string };
}
