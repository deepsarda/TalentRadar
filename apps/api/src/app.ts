import { existsSync } from "node:fs";
import path from "node:path";
import type { Express } from "express";
import express from "express";
import helmet from "helmet";

export interface AppOptions {
  staticDirectory?: string;
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

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "talentradar-api",
      version: "0.1.0",
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get("/api", (_request, response) => {
    response.json({
      name: "TalentRadar API",
      status: "ready",
      documentation: "Public discovery and authenticated workspace routes are served under /api.",
    });
  });

  app.get("/api/public/events", (_request, response) => {
    response.json({ events: [] });
  });

  app.get("/api/public/events/:slug", (_request, response) => {
    response.status(404).json({
      error: "event_not_found",
      message: "This event is not published or does not exist",
    });
  });

  app.get("/api/me", (_request, response) => {
    response.status(401).json({
      error: "authentication_required",
      message: "Sign in with GitHub to open an account workspace",
    });
  });

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

  return app;
}
