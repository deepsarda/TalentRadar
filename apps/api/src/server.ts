import path from "node:path";
import { createApp } from "./app.js";
import { readEnvironment } from "./config/environment.js";

const environment = readEnvironment();
const staticDirectory = environment.WEB_DIST_DIR ?? path.resolve(process.cwd(), "apps/web/dist");
const app = createApp({ staticDirectory });

const server = app.listen(environment.PORT, "0.0.0.0", () => {
  console.log(`TalentRadar listening on port ${environment.PORT}`);
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} received; closing HTTP server`);
  server.close((error) => {
    if (error) {
      console.error("HTTP shutdown failed", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
