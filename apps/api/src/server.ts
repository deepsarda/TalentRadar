import path from "node:path";
import { createApp } from "./app.js";
import { createGithubAuthentication } from "./auth/github.js";
import { readEnvironment } from "./config/environment.js";
import { connectDatabase } from "./database/mongo.js";
import { createOrganizerEventsApi } from "./events/organizer-events.js";
import { createMongoPublicEventRepository } from "./events/public-events.js";
import { startWorker } from "./jobs/worker.js";
import { createParticipantApi } from "./participants/participant-api.js";
import { createAggregateProfileHandler } from "./profile-pipeline/aggregate.js";
import { createRenderCvHandler } from "./profile-pipeline/cv.js";
import { createJudgePersonHandler } from "./profile-pipeline/judge.js";
import { createProfileOrchestrator } from "./profile-pipeline/orchestrator.js";
import { createFetchRepositoryHandler } from "./profile-pipeline/repository.js";
import { createImportRowHandler } from "./quick/import-row.js";
import { createQuickApi } from "./quick/quick-api.js";
import { createShortlistApi } from "./shortlist/shortlist-api.js";
import { createTeamApi } from "./teams/team-api.js";

const environment = readEnvironment();
const staticDirectory = environment.WEB_DIST_DIR ?? path.resolve(process.cwd(), "apps/web/dist");

async function main(): Promise<void> {
  const database = environment.MONGODB_URI ? await connectDatabase(environment.MONGODB_URI) : null;
  const authentication =
    database &&
    environment.GITHUB_CLIENT_ID &&
    environment.GITHUB_CLIENT_SECRET &&
    environment.SESSION_SECRET
      ? createGithubAuthentication(database.db, environment)
      : undefined;
  const publicEvents = database ? createMongoPublicEventRepository(database.db) : undefined;
  const organizerEvents =
    database && authentication ? createOrganizerEventsApi(database.db, authentication) : undefined;
  const participantApi =
    database && authentication
      ? createParticipantApi(database.db, authentication, environment)
      : undefined;
  const teamApi =
    database && authentication ? createTeamApi(database.db, authentication) : undefined;
  const shortlistApi =
    database && authentication ? createShortlistApi(database.db, authentication) : undefined;
  const quickApi =
    database && authentication
      ? createQuickApi(database.db, authentication, environment)
      : undefined;
  const orchestrator = database ? createProfileOrchestrator(database.db) : undefined;
  const worker =
    database && environment.RUN_WORKER_IN_API && environment.SESSION_SECRET
      ? startWorker(
          database.db,
          {
            fetch_repo: createFetchRepositoryHandler({
              db: database.db,
              sessionSecret: environment.SESSION_SECRET,
              repoTokenBudget: environment.REPO_TOKEN_BUDGET,
            }),
            render_cv: createRenderCvHandler(database.db),
            judge_person: createJudgePersonHandler(database.db, environment),
            aggregate_profile: createAggregateProfileHandler(database.db),
            import_row: createImportRowHandler(database.db, environment.SESSION_SECRET),
          },
          {
            ...(orchestrator
              ? {
                  onCompleted: orchestrator.completed,
                  onTerminalFailure: orchestrator.failed,
                }
              : {}),
          },
        )
      : undefined;
  const app = createApp({
    staticDirectory,
    ...(authentication ? { authentication } : {}),
    ...(publicEvents ? { publicEvents } : {}),
    ...(organizerEvents || participantApi || teamApi || shortlistApi || quickApi
      ? {
          apiModules: [organizerEvents, participantApi, teamApi, shortlistApi, quickApi].filter(
            (module) => module !== undefined,
          ),
        }
      : {}),
    readiness: async () => {
      if (!database) return false;
      await database.db.command({ ping: 1 });
      return true;
    },
    publicConfig: { modelDataPolicy: environment.MODEL_DATA_POLICY },
  });

  if (environment.NODE_ENV === "production") app.set("trust proxy", 1);

  const server = app.listen(environment.PORT, "0.0.0.0", () => {
    console.log(`TalentRadar listening on port ${environment.PORT}`);
  });

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received; closing TalentRadar`);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await worker?.stop();
    await database?.client.close();
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("TalentRadar failed to start", error);
  process.exitCode = 1;
});
