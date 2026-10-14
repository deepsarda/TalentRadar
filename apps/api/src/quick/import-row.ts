import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import { decryptSecret } from "../auth/crypto.js";
import type { UserDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import { enqueueJob } from "../jobs/queue.js";
import { githubFetch } from "../jobs/rate-limit.js";
import type { JobContext } from "../jobs/worker.js";

const ImportRowPayloadSchema = z.object({
  profileId: z.string().length(24),
  personId: z.string().length(24),
  eventId: z.string().length(24),
  accessUserId: z.string().length(24),
  github: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
    .optional(),
  cvFileId: z.string().length(24).optional(),
});

const GithubRepositorySchema = z.object({
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  name: z.string(),
  fork: z.boolean(),
  size: z.number().int().nonnegative(),
  pushed_at: z.iso.datetime({ offset: true }).nullable(),
});

/**
 * The spec's repo choice for people nobody signed in for: the 6 most recently pushed non-fork
 * public repositories under 50 MB (archived ones included), skipping the profile README repository.
 */
export async function selectRecentRepositories(
  login: string,
  token: string,
  fetchImplementation: typeof fetch = githubFetch,
): Promise<Array<{ fullName: string; pushedAt: string; fork: boolean }>> {
  const response = await fetchImplementation(
    `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&direction=desc&type=owner`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2026-03-10",
      },
    },
  );
  if (!response.ok) {
    const reset = response.headers.get("x-ratelimit-reset");
    throw new Error(
      response.status === 404
        ? `GitHub user @${login} was not found`
        : response.status === 403 || response.status === 429
          ? `GitHub rate limited the import${reset ? ` until ${new Date(Number(reset) * 1000).toISOString()}` : ""}`
          : `GitHub returned ${response.status} for @${login}`,
    );
  }
  const parsed = z.array(GithubRepositorySchema).parse(await response.json());
  return parsed
    .filter(
      (repository) =>
        !repository.fork &&
        repository.size > 0 &&
        repository.size <= 51_200 &&
        repository.pushed_at &&
        repository.name.toLowerCase() !== login.toLowerCase(),
    )
    .slice(0, 6)
    .map((repository) => ({
      fullName: repository.full_name,
      pushedAt: repository.pushed_at ?? "",
      fork: repository.fork,
    }));
}

export function createImportRowHandler(db: Db, sessionSecret: string) {
  return async ({ job, progress }: JobContext): Promise<Record<string, unknown>> => {
    const payload = ImportRowPayloadSchema.parse(job.payload);
    const accessUser = await db
      .collection<UserDocument>(collections.users)
      .findOne({ _id: ObjectId.createFromHexString(payload.accessUserId) });
    if (!accessUser) throw new Error("Import owner no longer exists");

    const repositories: Awaited<ReturnType<typeof selectRecentRepositories>> = [];
    if (payload.github) {
      await progress(
        "import.github.started",
        `Finding recent public repositories for @${payload.github}`,
      );
      const token = decryptSecret(accessUser.encryptedAccessToken, sessionSecret);
      repositories.push(...(await selectRecentRepositories(payload.github, token)));
      await progress(
        "import.github.completed",
        `Selected ${repositories.length} recent non-fork repositories for @${payload.github}`,
      );
    }

    if (repositories.length === 0 && !payload.cvFileId) {
      throw new Error("Import row has neither an eligible GitHub repository nor a matched CV");
    }

    await db.collection(collections.profiles).updateOne(
      { _id: ObjectId.createFromHexString(payload.profileId) },
      {
        $set: {
          repos: repositories.map((repository) => ({
            fullName: repository.fullName,
            included: true,
          })),
          updatedAt: new Date(),
        },
      },
    );
    await db.collection(collections.registrations).updateOne(
      {
        hackathonId: ObjectId.createFromHexString(payload.eventId),
        personId: ObjectId.createFromHexString(payload.personId),
      },
      {
        $set: {
          selectedRepositories: repositories.map((repository) => repository.fullName),
          updatedAt: new Date(),
        },
      },
    );

    await Promise.all([
      ...repositories.map((repository) =>
        enqueueJob(
          db,
          "fetch_repo",
          {
            profileId: payload.profileId,
            personId: payload.personId,
            accessUserId: payload.accessUserId,
            repository: repository.fullName,
            pushedAt: repository.pushedAt,
            fork: repository.fork,
          },
          { dedupeKey: `${payload.profileId}:fetch_repo:${repository.fullName}` },
        ),
      ),
      ...(payload.cvFileId
        ? [
            enqueueJob(
              db,
              "render_cv",
              {
                profileId: payload.profileId,
                personId: payload.personId,
                fileId: payload.cvFileId,
              },
              { dedupeKey: `${payload.profileId}:render_cv` },
            ),
          ]
        : []),
    ]);
    return {
      repositories: repositories.length,
      cvMatched: Boolean(payload.cvFileId),
    };
  };
}
