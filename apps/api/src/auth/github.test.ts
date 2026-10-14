import express from "express";
import { ObjectId } from "mongodb";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Environment } from "../config/environment.js";
import { encryptSecret } from "./crypto.js";
import { createGithubAuthentication } from "./github.js";

const environment = {
  APP_ORIGIN: "http://app.test",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "s".repeat(32),
} as Environment;
const userId = new ObjectId();

function setup(githubStatus: number) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const writes: string[] = [];
  const user = {
    _id: userId,
    login: "riya",
    roles: ["participant"],
    encryptedAccessToken: encryptSecret("gho_secret", "s".repeat(32)),
  };
  const collection = (name: string) => ({
    findOneAndUpdate: async () => (name === "sessions" ? { _id: "hash", userId } : null),
    findOne: async () => (name === "users" ? user : null),
    updateOne: async (_filter: unknown, update: { $unset?: object }) => {
      writes.push(`${name}.update ${JSON.stringify(update.$unset)}`);
    },
    deleteMany: async (filter: { userId?: ObjectId }) => {
      writes.push(`${name}.deleteMany ${filter.userId?.toHexString()}`);
    },
  });
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return new Response(null, { status: githubStatus });
  }) as typeof fetch;
  const app = express();
  createGithubAuthentication({ collection } as never, environment, fakeFetch).register(app);
  return { app, calls, writes };
}

describe("GitHub access revocation", () => {
  it("revokes the grant at GitHub, deletes the stored token and signs out everywhere", async () => {
    const { app, calls, writes } = setup(204);
    const response = await request(app)
      .post("/auth/github/revoke")
      .set("cookie", "tr_session=raw")
      .expect(204);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/applications/client-id/token");
    expect(calls[0]?.init?.method).toBe("DELETE");
    const headers = calls[0]?.init?.headers as { authorization?: string };
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ access_token: "gho_secret" });
    expect(writes).toEqual([
      'users.update {"encryptedAccessToken":""}',
      `sessions.deleteMany ${userId.toHexString()}`,
    ]);
    expect(response.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  it("keeps the token and the session when GitHub does not confirm", async () => {
    const { app, writes } = setup(500);
    await request(app).post("/auth/github/revoke").set("cookie", "tr_session=raw").expect(502);
    expect(writes).toEqual([]);
  });

  it("requires a signed-in user", async () => {
    const { app, calls } = setup(204);
    // No cookie: readCurrentUser finds no session.
    await request(app).post("/auth/github/revoke").expect(401);
    expect(calls).toHaveLength(0);
  });
});
