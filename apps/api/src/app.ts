import { existsSync } from "node:fs";
import path from "node:path";
import type { Express } from "express";
import express from "express";
import helmet from "helmet";
import type { Authentication } from "./auth/github.js";
import type { PublicEventRepository } from "./events/public-events.js";

export interface AppOptions {
  staticDirectory?: string;
  authentication?: Authentication;
  publicEvents?: PublicEventRepository;
  readiness?: () => Promise<boolean>;
  apiModules?: Array<{ register(app: Express): void }>;
  publicConfig?: { modelDataPolicy: "synthetic_only" | "paid_private" };
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  options.authentication?.register(app);

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "talentradar-api",
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get("/ready", async (_request, response) => {
    const ready = (await options.readiness?.()) ?? false;
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      service: "talentradar-api",
    });
  });

  app.get("/api", (_request, response) => {
    response.json({
      name: "TalentRadar API",
      status: "ready",
      documentation: "Public discovery and authenticated workspace routes are served under /api.",
    });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      modelDataPolicy: options.publicConfig?.modelDataPolicy ?? "synthetic_only",
    });
  });

  app.get("/api/public/events", async (_request, response) => {
    if (!options.publicEvents) {
      response.status(503).json({
        error: "database_unavailable",
        message: "Published events are temporarily unavailable",
      });
      return;
    }
    response.json({ events: await options.publicEvents.list() });
  });

  app.get("/api/public/events/:slug", async (request, response) => {
    const event = await options.publicEvents?.findBySlug(request.params.slug ?? "");
    if (!event) {
      response.status(404).json({
        error: "event_not_found",
        message: "This event is not published or does not exist",
      });
      return;
    }
    response.json({ event });
  });

  app.get("/api/me", async (request, response) => {
    const user = await options.authentication?.currentUser(request);
    if (!user) {
      response.status(401).json({
        error: "authentication_required",
        message: "Sign in with GitHub to open an account workspace",
      });
      return;
    }
    response.json({ user });
  });

  for (const module of options.apiModules ?? []) module.register(app);

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "not_found", message: "API route not found" });
  });

  if (options.staticDirectory && existsSync(options.staticDirectory)) {
    const indexPath = path.join(options.staticDirectory, "index.html");
    app.use(express.static(options.staticDirectory, { index: false }));
    app.get(/^(?!\/(?:api|health)(?:\/|$)).*/, (_request, response) => {
      response.sendFile(indexPath);
    });
  } else {
    app.get("/", (_request, response) => {
      response.json({ name: "TalentRadar", api: "/api", health: "/health" });
    });
  }

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(
        "Unhandled request error",
        error instanceof Error ? error.message : "unknown error",
      );
      if (!response.headersSent) {
        if (
          error &&
          typeof error === "object" &&
          "type" in error &&
          error.type === "entity.too.large"
        ) {
          response
            .status(413)
            .json({ error: "file_too_large", message: "The uploaded file exceeds 2 MB" });
          return;
        }
        response
          .status(500)
          .json({ error: "internal_error", message: "The request could not be completed" });
      }
    },
  );

  return app;
}
