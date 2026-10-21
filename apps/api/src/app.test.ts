import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { PublicEventRepository } from "./events/public-events.js";

describe("TalentRadar API", () => {
  const publicEvents: PublicEventRepository = {
    list: async () => [],
    findBySlug: async () => null,
  };
  const app = createApp({ publicEvents, readiness: async () => true });

  it("reports a healthy service", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      service: "talentradar-api",
      version: "0.1.0",
    });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("returns structured API errors", async () => {
    const response = await request(app).get("/api/unknown").expect(404);

    expect(response.body).toEqual({ error: "not_found", message: "API route not found" });
  });

  it("reports database readiness separately from process liveness", async () => {
    const response = await request(app).get("/ready").expect(200);

    expect(response.body.status).toBe("ready");
  });

  it("returns an honest empty public event collection", async () => {
    const response = await request(app).get("/api/public/events").expect(200);

    expect(response.body).toEqual({ events: [] });
  });

  it("does not fabricate an event for an unknown slug", async () => {
    const response = await request(app).get("/api/public/events/not-real").expect(404);

    expect(response.body).toEqual({
      error: "event_not_found",
      message: "This event is not published or does not exist",
    });
  });

  it("requires authentication for an account workspace", async () => {
    const response = await request(app).get("/api/me").expect(401);

    expect(response.body.error).toBe("authentication_required");
  });
});

describe("request security", () => {
  const publicEvents: PublicEventRepository = {
    list: async () => [],
    findBySlug: async () => null,
  };

  it("blocks a state-changing request from another origin", async () => {
    const app = createApp({ publicEvents, allowedOrigins: ["https://talentradar.example"] });
    const response = await request(app)
      .post("/api/anything")
      .set("Origin", "https://evil.example")
      .expect(403);

    expect(response.body.error).toBe("cross_site_request");
  });

  it("blocks a browser-declared cross-site request with no Origin header", async () => {
    const app = createApp({ publicEvents });
    await request(app).delete("/api/anything").set("Sec-Fetch-Site", "cross-site").expect(403);
  });

  it("allows the configured origin and the host the request was sent to", async () => {
    const app = createApp({ publicEvents, allowedOrigins: ["https://talentradar.example"] });
    await request(app)
      .post("/api/anything")
      .set("Origin", "https://talentradar.example")
      .expect(404);
    await request(app)
      .post("/api/anything")
      .set("Host", "localhost:5173")
      .set("Origin", "http://localhost:5173")
      .expect(404);
  });

  it("never blocks safe methods or header-less non-browser clients", async () => {
    const app = createApp({ publicEvents });
    await request(app).get("/api/config").set("Origin", "https://evil.example").expect(200);
    await request(app).post("/api/anything").expect(404);
  });

  it("rate limits /api with a Retry-After header", async () => {
    const app = createApp({ publicEvents, rateLimits: { api: 3, auth: 3 } });
    for (let i = 0; i < 3; i += 1) await request(app).get("/api/config").expect(200);
    const response = await request(app).get("/api/config").expect(429);

    expect(response.body.error).toBe("rate_limited");
    expect(Number(response.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("does not rate limit health checks", async () => {
    const app = createApp({ publicEvents, rateLimits: { api: 1, auth: 1 } });
    for (let i = 0; i < 5; i += 1) await request(app).get("/health").expect(200);
  });
});
