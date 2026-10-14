import type { Db, ObjectId } from "mongodb";
import type { AuditEntryDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";

export type AuditInput = Omit<AuditEntryDocument, "_id" | "at" | "changes"> & {
  changes?: string[];
};

/** Appends one audit entry. The audit log is insert-only; nothing ever updates or deletes it. */
export async function recordAudit(db: Db, entry: AuditInput): Promise<void> {
  await db.collection<AuditEntryDocument>(collections.auditEntries).insertOne({
    ...entry,
    changes: entry.changes ?? [],
    at: new Date(),
  } as AuditEntryDocument);
}

export async function listAudit(db: Db, hackathonId: ObjectId, limit = 100) {
  return db
    .collection<AuditEntryDocument>(collections.auditEntries)
    .find({ hackathonId })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}

type Flat = Map<string, unknown>;

/** Plain objects become dotted paths; arrays and scalars are leaves. */
function flatten(value: unknown, prefix: string, into: Flat): Flat {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, into);
    }
  } else if (prefix) {
    into.set(prefix, value);
  }
  return into;
}

function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 16).replace("T", " ");
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 39)}…` : value);
  }
  return String(value);
}

/**
 * One line per changed leaf of the listed fields: `capacity: 100 → 120`,
 * `requirements: 3 → 4 items`, `description edited`.
 */
export function diffSummary(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  const changes: string[] = [];
  for (const field of fields) {
    const left = flatten(before[field], field, new Map());
    const right = flatten(after[field], field, new Map());
    for (const path of new Set([...left.keys(), ...right.keys()])) {
      const from = left.get(path);
      const to = right.get(path);
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      if (Array.isArray(from) || Array.isArray(to)) {
        const fromCount = Array.isArray(from) ? from.length : 0;
        const toCount = Array.isArray(to) ? to.length : 0;
        changes.push(
          fromCount === toCount ? `${path} edited` : `${path}: ${fromCount} → ${toCount} items`,
        );
      } else if (typeof from === "string" && typeof to === "string" && to.length > 40) {
        changes.push(`${path} edited`);
      } else {
        changes.push(`${path}: ${show(from)} → ${show(to)}`);
      }
    }
  }
  return changes;
}
