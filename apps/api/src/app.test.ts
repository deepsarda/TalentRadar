import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("TalentRadar API", () => {
  const app = createApp();

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
