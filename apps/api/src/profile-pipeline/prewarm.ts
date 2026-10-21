import type { Db } from "mongodb";
import { ObjectId } from "mongodb";
import type { PersonDocument, ProfileDocument, RegistrationDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import { enqueueJob } from "../jobs/queue.js";
import type { JobContext } from "../jobs/worker.js";

export function createPrewarmProfilesHandler(db: Db) {
  return async (context: JobContext) => {
    const hackathonId = ObjectId.createFromHexString(String(context.job.payload["hackathonId"]));
    await context.progress("scanning", "Scanning registrations for unprofiled participants");

    const registrations = await db
      .collection<RegistrationDocument>(collections.registrations)
      .find({ hackathonId, status: { $ne: "draft" } })
      .toArray();

    const personIds = registrations.map((r) => r.personId);
    if (personIds.length === 0) {
      await context.progress("done", "No registrations found to pre-warm");
      return { total: 0, queued: 0 };
    }

    // Check existing profiles
    const existingProfiles = await db
      .collection<ProfileDocument>(collections.profiles)
      .find({ personId: { $in: personIds } })
      .toArray();

    const readyOrPendingPersonIds = new Set(
      existingProfiles
        .filter((p) => p.status === "ready" || p.status === "building" || p.status === "pending")
        .map((p) => p.personId.toHexString()),
    );

    const neededPersonIds = personIds.filter(
      (id) => !readyOrPendingPersonIds.has(id.toHexString()),
    );

    await context.progress("batching", `Found ${neededPersonIds.length} profiles needing build`);

    let queuedCount = 0;
    // Process in batches
    for (let i = 0; i < neededPersonIds.length; i++) {
      if (context.signal.aborted) break;
      const personId = neededPersonIds[i]!;
      const person = await db
        .collection<PersonDocument>(collections.people)
        .findOne({ _id: personId });
      if (!person) continue;

      const reg = registrations.find((r) => r.personId.equals(personId));
      const repos = reg?.selectedRepositories ?? [];

      // Create new profile doc in pending state
      const profileDoc: Omit<ProfileDocument, "_id"> = {
        personId,
        displayName: person.name,
        skills: [],
        novelty: 0,
        flags: [],
        status: "pending",
        version: 1,
        repos: repos.map((r) => ({ fullName: r, included: true })),
        taxonomyVersion: "v1",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const inserted = await db
        .collection<ProfileDocument>(collections.profiles)
        .insertOne(profileDoc as ProfileDocument);

      for (const repo of repos) {
        await enqueueJob(
          db,
          "fetch_repo",
          {
            profileId: inserted.insertedId.toHexString(),
            personId: personId.toHexString(),
            repository: repo,
          },
          { maxAttempts: 3 },
        );
      }
      queuedCount++;

      if ((i + 1) % 10 === 0 || i === neededPersonIds.length - 1) {
        await context.progress(
          "enqueued",
          `Queued ${queuedCount} of ${neededPersonIds.length} profiles`,
        );
      }
    }

    await context.progress("completed", `Pre-warming complete: queued ${queuedCount} profiles`);
    return { total: neededPersonIds.length, queued: queuedCount };
  };
}
