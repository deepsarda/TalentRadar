import { createHash, randomInt } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  HackathonSchema,
  HackathonTimelineSchema,
  RequirementSchema,
  rubricVersion,
  taxonomyVersion,
} from "@talentradar/shared";
import type { Express, Request, Response } from "express";
import express from "express";
import {
  type Db,
  GridFSBucket,
  type GridFSBucketWriteStream,
  MongoServerError,
  ObjectId,
  type ObjectId as ObjectIdType,
} from "mongodb";
import Papa from "papaparse";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { z } from "zod";
import type { Authentication } from "../auth/github.js";
import type { Environment } from "../config/environment.js";
import type {
  HackathonDocument,
  JobDocument,
  PersonDocument,
  ProfileDocument,
  QuickImportDocument,
  RegistrationDocument,
  TeamDocument,
} from "../database/models.js";
import { collections } from "../database/mongo.js";
import { type ApiModule, detailsFields, requireVenue } from "../events/organizer-events.js";
import { enqueueJob } from "../jobs/queue.js";

const CreateQuickSchema = z.object({
  name: z.string().trim().min(3).max(80),
  teamSize: z
    .object({ min: z.number().int().min(1).max(6), max: z.number().int().min(1).max(6) })
    .refine((teamSize) => teamSize.min <= teamSize.max),
  capacity: z.number().int().min(1).max(5000),
  requirements: z.array(RequirementSchema).min(1).max(50),
});

const MappingSchema = z.object({
  mapping: z.object({
    name: z.string().min(1),
    email: z.string().min(1),
    github: z.string().optional(),
    cv_file: z.string().optional(),
    team_name: z.string().optional(),
    college: z.string().optional(),
    year_of_study: z.string().optional(),
    branch: z.string().optional(),
    city: z.string().optional(),
  }),
  consent: z.literal(true),
});

const ImportRowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  github: z.string().optional(),
  cvFile: z.string().optional(),
  teamName: z.string().trim().max(80).optional(),
  college: z.string().trim().max(200).optional(),
  year: z.string().trim().max(40).optional(),
  branch: z.string().trim().max(120).optional(),
  city: z.string().trim().max(120).optional(),
});

/**
 * What a quick run lacks to become a full event: its public page fields and timeline. Name,
 * team size, capacity, requirements, people, profiles and runs carry over unchanged. Field rules
 * are the event wizard's own, so a promoted event can never be something the wizard rejects.
 */
const PromoteQuickSchema = z
  .object({
    slug: detailsFields.slug,
    tagline: detailsFields.tagline,
    description: detailsFields.description,
    links: detailsFields.links,
    mode: detailsFields.mode,
    venue: detailsFields.venue,
    timeline: HackathonTimelineSchema,
  })
  .superRefine(requireVenue);

const MAX_CSV_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_ZIP_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_CV_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_ZIP_ENTRIES = 5_000;
const inviteAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

interface ParsedImportRow extends z.infer<typeof ImportRowSchema> {
  rowNumber: number;
}

class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function inviteCode(): string {
  return Array.from({ length: 8 }, () => inviteAlphabet[randomInt(inviteAlphabet.length)]).join("");
}

function safeName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return (
    decodeURIComponent(value)
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .slice(0, 120) || fallback
  );
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function suggestedMapping(headers: string[]): Record<string, string> {
  const aliases: Record<string, string[]> = {
    name: ["name", "full name", "participant name", "student name"],
    email: ["email", "email address", "e mail"],
    github: ["github", "github username", "github profile", "github profile link"],
    cv_file: ["cv", "cv file", "resume", "resume file", "upload your cv"],
    team_name: ["team", "team name", "group name"],
    college: ["college", "college name", "institution", "university"],
    year_of_study: ["year", "year of study", "academic year"],
    branch: ["branch", "department", "course"],
    city: ["city", "current city"],
  };
  const normalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  return Object.fromEntries(
    Object.entries(aliases).flatMap(([field, candidates]) => {
      const matched = candidates.map((candidate) => normalized.get(candidate)).find(Boolean);
      return matched ? [[field, matched]] : [];
    }),
  );
}

export function parseCsv(buffer: Buffer): {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
} {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
    errors: result.errors.map(
      (error) => `Row ${error.row === undefined ? "?" : error.row + 1}: ${error.message}`,
    ),
  };
}

function uploadBuffer(
  bucket: GridFSBucket,
  filename: string,
  buffer: Buffer,
  metadata: Record<string, unknown>,
): Promise<ObjectIdType> {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(filename, { metadata });
    stream.once("error", reject);
    stream.once("finish", () => resolve(stream.id));
    stream.end(buffer);
  });
}

function uploadRequest(
  request: Request,
  bucket: GridFSBucket,
  filename: string,
  maxBytes: number,
  metadata: Record<string, unknown>,
): Promise<{ id: ObjectIdType; size: number }> {
  return new Promise((resolve, reject) => {
    const stream: GridFSBucketWriteStream = bucket.openUploadStream(filename, { metadata });
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.destroy(error);
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new UploadError(`Upload exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`, 413));
        return;
      }
      if (!settled) stream.write(chunk);
    });
    request.once("error", fail);
    request.once("end", () => {
      if (settled) return;
      if (size === 0) {
        fail(new UploadError("Choose a file to upload", 422));
        return;
      }
      stream.end();
    });
    stream.once("error", (error) => {
      if (!settled) fail(error);
    });
    stream.once("finish", () => {
      if (settled) return;
      settled = true;
      resolve({ id: stream.id, size });
    });
  });
}

function downloadBuffer(bucket: GridFSBucket, id: ObjectIdType, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = bucket.openDownloadStream(id);
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stream.destroy(new Error("Stored file exceeds its size limit"));
      else chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("ZIP archive could not be opened"));
      else resolve(zip);
    });
  });
}

function readZipEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("ZIP entry could not be read"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_CV_BYTES) stream.destroy(new Error("CV exceeds 2 MB"));
        else chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function cvReferenceName(value: string | undefined): string {
  if (!value) return "";
  try {
    const decoded = decodeURIComponent(value);
    return path.basename(decoded.split("?")[0] ?? decoded).toLowerCase();
  } catch {
    return path.basename(value).toLowerCase();
  }
}

async function matchArchiveCvs(
  archivePath: string,
  rows: readonly ParsedImportRow[],
  cvBucket: GridFSBucket,
  importId: ObjectIdType,
): Promise<Map<number, ObjectIdType>> {
  const zip = await openZip(archivePath);
  const matched = new Map<number, ObjectIdType>();
  let entryCount = 0;
  let expandedBytes = 0;

  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      zip.close();
      reject(error);
    };
    zip.once("error", fail);
    zip.once("end", () => resolve(matched));
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        entryCount += 1;
        expandedBytes += entry.uncompressedSize;
        if (entryCount > MAX_ZIP_ENTRIES || expandedBytes > MAX_ZIP_BYTES) {
          throw new UploadError("ZIP archive expands beyond safe limits", 422);
        }
        if ((entry.generalPurposeBitFlag & 1) !== 0) {
          throw new UploadError("Encrypted ZIP entries are not supported", 422);
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 100) {
          throw new UploadError("ZIP archive contains a suspicious compression ratio", 422);
        }
        const entryName = entry.fileName.toLowerCase();
        if (entryName.includes("\0") || entryName.endsWith("/") || !entryName.endsWith(".pdf")) {
          zip.readEntry();
          return;
        }
        const baseName = path.basename(entryName);
        const matchingRows = rows.filter((row) => {
          if (matched.has(row.rowNumber)) return false;
          const reference = cvReferenceName(row.cvFile);
          return (
            (reference && (baseName === reference || baseName.includes(reference))) ||
            baseName.includes(row.email.toLowerCase())
          );
        });
        if (matchingRows.length === 0) {
          zip.readEntry();
          return;
        }
        const buffer = await readZipEntry(zip, entry);
        if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
          zip.readEntry();
          return;
        }
        const now = new Date();
        const fileId = await uploadBuffer(cvBucket, safeName(baseName, "cv.pdf"), buffer, {
          importId,
          sourceEntry: entry.fileName,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          uploadedAt: now,
          contentType: "application/pdf",
        });
        for (const row of matchingRows) matched.set(row.rowNumber, fileId);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

export function normalizeGithub(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim().replace(/^@/, "");
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (url.hostname.toLowerCase() === "github.com")
      return url.pathname.split("/").filter(Boolean)[0];
  } catch {
    // A plain username is handled below.
  }
  return trimmed.split("/").filter(Boolean).at(-1);
}

function mappedRow(
  row: Record<string, string>,
  rowNumber: number,
  mapping: z.infer<typeof MappingSchema>["mapping"],
): ParsedImportRow | null {
  const read = (field: keyof typeof mapping) => {
    const column = mapping[field];
    return column ? row[column]?.trim() : undefined;
  };
  const parsed = ImportRowSchema.safeParse({
    name: read("name"),
    email: read("email"),
    github: normalizeGithub(read("github")),
    cvFile: read("cv_file"),
    teamName: read("team_name"),
    college: read("college"),
    year: read("year_of_study"),
    branch: read("branch"),
    city: read("city"),
  });
  return parsed.success ? { ...parsed.data, rowNumber } : null;
}

/**
 * Rows with the same team name (case and spacing ignored) form one team. A blank team name is a
 * team of one; when solos are not allowed it is still kept, flagged unteamed, so the ranking
 * shows it as ineligible instead of silently dropping the person.
 */
export function groupImportRows<
  Row extends { rowNumber: number; name: string; teamName?: string | undefined },
>(
  rows: readonly Row[],
  minTeamSize: number,
): Array<{ importKey: string; name: string; rows: Row[]; unteamed: boolean }> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const normalizedTeam = row.teamName?.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    const key = normalizedTeam || `solo:${row.rowNumber}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return [...grouped].map(([importKey, teamRows]) => {
    const first = teamRows[0];
    const teamName = first?.teamName?.trim();
    const unteamed = !teamName && minTeamSize > 1;
    return {
      importKey,
      name: teamName || `${unteamed ? "No team" : "Solo"} — ${first?.name ?? "Participant"}`,
      rows: teamRows,
      unteamed,
    };
  });
}

export function createQuickApi(
  db: Db,
  authentication: Authentication,
  environment: Environment,
): ApiModule {
  const importBucket = new GridFSBucket(db, { bucketName: "imports" });
  const cvBucket = new GridFSBucket(db, { bucketName: "cv" });
  if (!environment.SESSION_SECRET) throw new Error("Quick imports require a session secret");

  async function organizer(request: Request, response: Response): Promise<ObjectIdType | null> {
    const user = await authentication.currentUser(request);
    if (!user) {
      response
        .status(401)
        .json({ error: "authentication_required", message: "Sign in to import registrations" });
      return null;
    }
    return ObjectId.createFromHexString(user.id);
  }

  async function ownedImport(
    request: Request,
    response: Response,
  ): Promise<{
    ownerId: ObjectIdType;
    event: HackathonDocument;
    quickImport: QuickImportDocument;
  } | null> {
    const ownerId = await organizer(request, response);
    if (!ownerId) return null;
    const { quickId: rawQuickId } = request.params as { quickId?: string | string[] };
    const quickId = Array.isArray(rawQuickId) ? rawQuickId[0] : rawQuickId;
    if (!quickId || !ObjectId.isValid(quickId)) {
      response.status(404).json({ error: "import_not_found", message: "Quick import not found" });
      return null;
    }
    const event = await db.collection<HackathonDocument>(collections.hackathons).findOne({
      _id: ObjectId.createFromHexString(quickId),
      kind: "quick",
      organizerIds: ownerId,
    });
    if (!event) {
      response.status(404).json({ error: "import_not_found", message: "Quick import not found" });
      return null;
    }
    const quickImport = await db
      .collection<QuickImportDocument>(collections.quickImports)
      .findOne({ hackathonId: event._id, organizerId: ownerId });
    if (!quickImport) throw new Error("Quick import metadata is missing");
    return { ownerId, event, quickImport };
  }

  return {
    register(app: Express) {
      app.post("/api/organizer/quick", async (request, response) => {
        const ownerId = await organizer(request, response);
        if (!ownerId) return;
        const parsed = CreateQuickSchema.safeParse(request.body);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
            .join("; ");
          response.status(422).json({
            error: "validation_failed",
            message: `Quick shortlist setup is incomplete (${detail})`,
          });
          return;
        }
        const now = new Date();
        const eventId = new ObjectId();
        const event: HackathonDocument = {
          _id: eventId,
          kind: "quick",
          slug: `quick-${eventId.toHexString()}`,
          taxonomyVersion,
          rubricVersion,
          name: parsed.data.name,
          tagline: "Imported registration shortlist",
          description: "Private quick shortlist workspace",
          links: [],
          mode: "online",
          organizerIds: [ownerId],
          teamSize: parsed.data.teamSize,
          capacity: parsed.data.capacity,
          requirements: parsed.data.requirements,
          ranking: {
            requirements: parsed.data.requirements,
            alpha: 0.7,
            noveltyWeight: 10,
            confidenceFactors: { high: 1, medium: 0.85, low: 0.6 },
            minFit: 0,
            minTeamSize: parsed.data.teamSize.min,
            maxTeamSize: parsed.data.teamSize.max,
          },
          quotas: [],
          collegeAliases: {},
          visibility: "draft",
          createdAt: now,
          updatedAt: now,
        };
        const quickImport: QuickImportDocument = {
          _id: new ObjectId(),
          hackathonId: eventId,
          organizerId: ownerId,
          headers: [],
          rowCount: 0,
          status: "created",
          createdAt: now,
          updatedAt: now,
        };
        await db.client.withSession(async (session) => {
          await session.withTransaction(async () => {
            await db
              .collection<HackathonDocument>(collections.hackathons)
              .insertOne(event, { session });
            await db
              .collection<QuickImportDocument>(collections.quickImports)
              .insertOne(quickImport, { session });
          });
        });
        response.status(201).json({ quick: { id: eventId.toHexString(), name: event.name } });
      });

      app.put(
        "/api/organizer/quick/:quickId/csv",
        express.raw({ type: ["text/csv", "application/csv", "text/plain"], limit: MAX_CSV_BYTES }),
        async (request, response) => {
          const owned = await ownedImport(request, response);
          if (!owned) return;
          if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
            response.status(422).json({ error: "csv_required", message: "Choose a CSV file" });
            return;
          }
          const parsed = parseCsv(request.body);
          if (parsed.headers.length === 0 || parsed.rows.length === 0) {
            response
              .status(422)
              .json({ error: "invalid_csv", message: "CSV needs a header and at least one row" });
            return;
          }
          if (parsed.rows.length > 2_000) {
            response
              .status(422)
              .json({ error: "too_many_rows", message: "CSV is limited to 2,000 rows" });
            return;
          }
          if (parsed.errors.length > 0) {
            response.status(422).json({
              error: "invalid_csv",
              message: parsed.errors.slice(0, 3).join(" "),
            });
            return;
          }
          const fileId = await uploadBuffer(
            importBucket,
            safeName(request.headers["x-file-name"], "responses.csv"),
            request.body,
            {
              hackathonId: owned.event._id,
              organizerId: owned.ownerId,
              contentType: "text/csv",
              uploadedAt: new Date(),
            },
          );
          await db.collection<QuickImportDocument>(collections.quickImports).updateOne(
            { _id: owned.quickImport._id },
            {
              $set: {
                csvFileId: fileId,
                headers: parsed.headers,
                rowCount: parsed.rows.length,
                status: "created",
                updatedAt: new Date(),
              },
              $unset: { mapping: "", error: "" },
            },
          );
          if (owned.quickImport.csvFileId) await importBucket.delete(owned.quickImport.csvFileId);
          response.json({
            csv: {
              headers: parsed.headers,
              rowCount: parsed.rows.length,
              suggestedMapping: suggestedMapping(parsed.headers),
              preview: parsed.rows.slice(0, 5),
            },
          });
        },
      );

      app.put("/api/organizer/quick/:quickId/archive", async (request, response) => {
        const owned = await ownedImport(request, response);
        if (!owned) return;
        if (!request.is("application/zip") && !request.is("application/x-zip-compressed")) {
          response
            .status(415)
            .json({ error: "invalid_archive", message: "CV archive must be a ZIP file" });
          return;
        }
        try {
          const uploaded = await uploadRequest(
            request,
            importBucket,
            safeName(request.headers["x-file-name"], "cv-archive.zip"),
            MAX_ZIP_BYTES,
            {
              hackathonId: owned.event._id,
              organizerId: owned.ownerId,
              contentType: "application/zip",
              uploadedAt: new Date(),
            },
          );
          await db
            .collection<QuickImportDocument>(collections.quickImports)
            .updateOne(
              { _id: owned.quickImport._id },
              { $set: { zipFileId: uploaded.id, updatedAt: new Date() } },
            );
          if (owned.quickImport.zipFileId) await importBucket.delete(owned.quickImport.zipFileId);
          response.json({ archive: { size: uploaded.size } });
        } catch (error) {
          const status = error instanceof UploadError ? error.status : 422;
          response.status(status).json({
            error: "archive_upload_failed",
            message: error instanceof Error ? error.message : "Archive upload failed",
          });
        }
      });

      app.post("/api/organizer/quick/:quickId/start", async (request, response) => {
        const owned = await ownedImport(request, response);
        if (!owned) return;
        const parsedRequest = MappingSchema.safeParse(request.body);
        if (!parsedRequest.success || !owned.quickImport.csvFileId) {
          response
            .status(422)
            .json({ error: "mapping_required", message: "Upload and map a CSV before starting" });
          return;
        }
        const mappedColumns = Object.values(parsedRequest.data.mapping).filter(
          (column): column is string => Boolean(column),
        );
        if (mappedColumns.some((column) => !owned.quickImport.headers.includes(column))) {
          response
            .status(422)
            .json({ error: "invalid_mapping", message: "A mapped CSV column no longer exists" });
          return;
        }
        if (owned.quickImport.status === "profiling" || owned.quickImport.status === "ready") {
          response
            .status(409)
            .json({ error: "import_started", message: "This import has already started" });
          return;
        }
        const csv = parseCsv(
          await downloadBuffer(importBucket, owned.quickImport.csvFileId, MAX_CSV_BYTES),
        );
        const rows = csv.rows.flatMap((row, index) => {
          const mapped = mappedRow(row, index + 2, parsedRequest.data.mapping);
          return mapped ? [mapped] : [];
        });
        const invalidRows = csv.rows.length - rows.length;
        if (rows.length === 0) {
          response.status(422).json({
            error: "no_valid_rows",
            message: "No rows have valid names and email addresses",
          });
          return;
        }

        const temporaryRoot = await mkdtemp(path.join(tmpdir(), "talentradar-import-"));
        let matchedCvs = new Map<number, ObjectIdType>();
        try {
          if (owned.quickImport.zipFileId) {
            const archivePath = path.join(temporaryRoot, "archive.zip");
            await pipeline(
              importBucket.openDownloadStream(owned.quickImport.zipFileId),
              createWriteStream(archivePath),
            );
            matchedCvs = await matchArchiveCvs(archivePath, rows, cvBucket, owned.quickImport._id);
          }
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }

        const peopleByRow = new Map<number, PersonDocument>();
        const now = new Date();
        for (const row of rows) {
          const cvFileId = matchedCvs.get(row.rowNumber);
          const person = await db.collection<PersonDocument>(collections.people).findOneAndUpdate(
            { importId: owned.quickImport._id, importRow: row.rowNumber },
            {
              $set: {
                name: row.name,
                email: row.email,
                github: row.github ?? "",
                verified: false,
                ...(row.college ? { college: row.college } : {}),
                ...(row.year ? { year: row.year } : {}),
                ...(row.branch ? { branch: row.branch } : {}),
                ...(row.city ? { city: row.city } : {}),
                ...(cvFileId ? { currentCvFileId: cvFileId } : {}),
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true, returnDocument: "after" },
          );
          if (!person) throw new Error(`Import row ${row.rowNumber} could not be saved`);
          peopleByRow.set(row.rowNumber, person);
          const registrationSet = {
            selectedRepositories: [] as string[],
            consentAt: now,
            status: "submitted" as const,
            lookingForTeam: false,
            ...(cvFileId ? { cvFileId } : {}),
            updatedAt: now,
          };
          await db
            .collection<RegistrationDocument>(collections.registrations)
            .updateOne(
              { hackathonId: owned.event._id, personId: person._id },
              { $set: registrationSet, $setOnInsert: { createdAt: now } },
              { upsert: true },
            );
          let profile = await db
            .collection<ProfileDocument>(collections.profiles)
            .findOne({ personId: person._id, version: 1 });
          if (!profile) {
            profile = {
              _id: new ObjectId(),
              personId: person._id,
              displayName: row.name,
              status: "pending",
              version: 1,
              repos: [],
              skills: [],
              novelty: 0,
              flags: [],
              taxonomyVersion,
              createdAt: now,
              updatedAt: now,
            };
            await db.collection<ProfileDocument>(collections.profiles).insertOne(profile);
          }
          const existingJob = await db.collection<JobDocument>(collections.jobs).findOne({
            type: "import_row",
            "payload.profileId": profile._id.toHexString(),
          });
          if (!existingJob) {
            await enqueueJob(
              db,
              "import_row",
              {
                profileId: profile._id.toHexString(),
                personId: person._id.toHexString(),
                eventId: owned.event._id.toHexString(),
                accessUserId: owned.ownerId.toHexString(),
                ...(row.github ? { github: row.github } : {}),
                ...(cvFileId ? { cvFileId: cvFileId.toHexString() } : {}),
              },
              { maxAttempts: 3 },
            );
          }
        }

        for (const { importKey, name: displayName, rows: teamRows, unteamed } of groupImportRows(
          rows,
          owned.event.teamSize.min,
        )) {
          const members = teamRows
            .map((row) => peopleByRow.get(row.rowNumber)?._id)
            .filter((id): id is ObjectIdType => Boolean(id));
          const captainId = members[0];
          if (!captainId) continue;
          const team = await db.collection<TeamDocument>(collections.teams).findOneAndUpdate(
            { hackathonId: owned.event._id, importKey },
            {
              $set: {
                name: displayName,
                captainId,
                memberIds: members,
                status: "submitted",
                submittedAt: now,
                updatedAt: now,
                ...(unteamed ? { unteamed: true } : {}),
              },
              $setOnInsert: { inviteCode: inviteCode(), createdAt: now },
            },
            { upsert: true, returnDocument: "after" },
          );
          if (!team) throw new Error(`Imported team ${displayName} could not be saved`);
          await db
            .collection<RegistrationDocument>(collections.registrations)
            .updateMany(
              { hackathonId: owned.event._id, personId: { $in: members } },
              { $set: { teamId: team._id, status: "submitted", updatedAt: now } },
            );
        }
        const storedMapping = Object.fromEntries(
          Object.entries(parsedRequest.data.mapping).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        await db.collection<QuickImportDocument>(collections.quickImports).updateOne(
          { _id: owned.quickImport._id },
          {
            $set: {
              mapping: storedMapping,
              status: "profiling",
              consentAt: now,
              updatedAt: now,
            },
            $unset: { error: "" },
          },
        );
        response.status(202).json({
          import: {
            id: owned.event._id.toHexString(),
            rowsAccepted: rows.length,
            rowsRejected: invalidRows,
            cvsMatched: matchedCvs.size,
          },
        });
      });

      app.post("/api/organizer/quick/:quickId/promote", async (request, response) => {
        const owned = await ownedImport(request, response);
        if (!owned) return;
        const parsed = PromoteQuickSchema.safeParse(request.body);
        if (!parsed.success) {
          response.status(422).json({
            error: "validation_failed",
            message: "Some event fields are invalid",
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
          return;
        }
        const { timeline } = parsed.data;
        // The promoted document must still be a valid hackathon as a whole.
        const whole = HackathonSchema.safeParse({
          hackathonId: owned.event._id.toHexString(),
          kind: "event",
          slug: parsed.data.slug,
          name: owned.event.name,
          organizerIds: owned.event.organizerIds.map((id) => id.toHexString()),
          capacity: owned.event.capacity,
          timeline,
          ranking: owned.event.ranking,
          visibility: "draft",
        });
        if (!whole.success) {
          response.status(422).json({
            error: "validation_failed",
            message: "This quick shortlist cannot become an event as configured",
          });
          return;
        }
        const now = new Date();
        try {
          const promoted = await db.collection<HackathonDocument>(collections.hackathons).updateOne(
            { _id: owned.event._id, kind: "quick" },
            {
              $set: {
                kind: "event",
                slug: parsed.data.slug,
                tagline: parsed.data.tagline,
                description: parsed.data.description,
                links: parsed.data.links,
                mode: parsed.data.mode,
                ...(parsed.data.venue ? { venue: parsed.data.venue } : {}),
                timeline: {
                  timezone: timeline.timezone,
                  registrationOpensAt: new Date(timeline.registrationOpensAt),
                  registrationClosesAt: new Date(timeline.registrationClosesAt),
                  shortlistPublishesAt: new Date(timeline.shortlistPublishesAt),
                  rsvpDeadlineAt: new Date(timeline.rsvpDeadlineAt),
                  eventStartsAt: new Date(timeline.eventStartsAt),
                  eventEndsAt: new Date(timeline.eventEndsAt),
                },
                visibility: "draft",
                updatedAt: now,
              },
              ...(parsed.data.venue ? {} : { $unset: { venue: "" } }),
            },
          );
          if (promoted.modifiedCount === 0) {
            response
              .status(409)
              .json({ error: "already_promoted", message: "This run is already an event" });
            return;
          }
        } catch (error) {
          if (error instanceof MongoServerError && error.code === 11000) {
            response.status(409).json({
              error: "slug_unavailable",
              message: "That public event slug is already in use",
            });
            return;
          }
          throw error;
        }
        response.json({
          event: { id: owned.event._id.toHexString(), kind: "event", slug: parsed.data.slug },
        });
      });

      app.get("/api/organizer/quick/:quickId", async (request, response) => {
        const owned = await ownedImport(request, response);
        if (!owned) return;
        const people = await db
          .collection<PersonDocument>(collections.people)
          .find({ importId: owned.quickImport._id })
          .toArray();
        const personIds = people.map((person) => person._id);
        const profiles = personIds.length
          ? await db
              .collection<ProfileDocument>(collections.profiles)
              .find({ personId: { $in: personIds } })
              .toArray()
          : [];
        const profileIds = profiles.map((profile) => profile._id.toHexString());
        const jobs = profileIds.length
          ? await db
              .collection<JobDocument>(collections.jobs)
              .find({ "payload.profileId": { $in: profileIds } })
              .sort({ updatedAt: -1 })
              .toArray()
          : [];
        const ready = profiles.filter((profile) => profile.status === "ready").length;
        const failed = profiles.filter((profile) => profile.status === "failed").length;
        const complete = profiles.length > 0 && ready + failed === profiles.length;
        if (complete && owned.quickImport.status === "profiling") {
          await db
            .collection<QuickImportDocument>(collections.quickImports)
            .updateOne(
              { _id: owned.quickImport._id, status: "profiling" },
              { $set: { status: "ready", updatedAt: new Date() } },
            );
        }
        response.json({
          quick: {
            id: owned.event._id.toHexString(),
            name: owned.event.name,
            status: complete ? "ready" : owned.quickImport.status,
            headers: owned.quickImport.headers,
            suggestedMapping: suggestedMapping(owned.quickImport.headers),
            rowCount: owned.quickImport.rowCount,
            hasCsv: Boolean(owned.quickImport.csvFileId),
            hasArchive: Boolean(owned.quickImport.zipFileId),
            mapping: owned.quickImport.mapping,
            progress: {
              total: profiles.length,
              ready,
              failed,
              pending: profiles.length - ready - failed,
            },
            failures: profiles
              .filter((profile) => profile.status === "failed")
              .slice(0, 100)
              .map((profile) => ({
                personId: profile.personId.toHexString(),
                name: profile.displayName,
                error: profile.error ?? "Profile failed",
              })),
            recentEvents: jobs
              .flatMap((job) => job.progress.slice(-1))
              .slice(0, 20)
              .map((event) => ({ at: event.at.toISOString(), message: event.message })),
          },
        });
      });
    },
  };
}
