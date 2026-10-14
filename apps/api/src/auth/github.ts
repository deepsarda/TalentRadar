import type { Express, Request } from "express";
import { type Db, ObjectId } from "mongodb";
import { z } from "zod";
import type { Environment } from "../config/environment.js";
import type { OAuthStateDocument, PersonDocument, UserDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import { decryptSecret, encryptSecret, hashToken, pkceChallenge, randomToken } from "./crypto.js";
import {
  type CurrentUser,
  createSession,
  destroyAllSessions,
  destroySession,
  readCurrentUser,
} from "./session.js";

const OAuthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(32),
});

const GithubTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string(),
});

const GithubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.url(),
});

const GithubEmailSchema = z.array(
  z.object({
    email: z.email(),
    primary: z.boolean(),
    verified: z.boolean(),
  }),
);

const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const GITHUB_API_VERSION = "2026-03-10";

function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
    return "/participant";
  return value.slice(0, 2048);
}

export function appOrigin(environment: Environment): string {
  return (
    environment.APP_ORIGIN ??
    environment.RENDER_EXTERNAL_URL ??
    `http://localhost:${environment.PORT}`
  );
}

function callbackUrl(environment: Environment): string {
  return new URL("/auth/github/callback", appOrigin(environment)).toString();
}

export function isSecure(environment: Environment): boolean {
  return environment.NODE_ENV === "production" || appOrigin(environment).startsWith("https:");
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : `GitHub returned ${response.status}`;
    throw new Error(message);
  }
  return body;
}

/** Same-origin check for state-changing cookie requests; browsers always send Origin on POST. */
export function trustedOrigin(request: Request, environment: Environment): boolean {
  const origin = request.headers.origin;
  return !origin || origin === appOrigin(environment);
}

/**
 * Revokes the OAuth grant at GitHub (DELETE /applications/{client_id}/token, basic auth with the
 * app's client credentials). A 404 means GitHub no longer knows the token, which is the goal.
 */
export async function revokeGithubToken(
  environment: Environment,
  encryptedAccessToken: string | undefined,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = environment;
  const sessionSecret = environment.SESSION_SECRET;
  if (!clientId || !clientSecret || !sessionSecret) {
    throw new Error("GitHub revocation requires client credentials and a session secret");
  }
  if (encryptedAccessToken === undefined) return;
  const response = await fetchImplementation(
    `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
    {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ access_token: decryptSecret(encryptedAccessToken, sessionSecret) }),
    },
  );
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(`GitHub token revocation failed with ${response.status}`);
  }
}

export interface Authentication {
  register(app: Express): void;
  currentUser(request: Request): Promise<CurrentUser | null>;
}

export function createGithubAuthentication(
  db: Db,
  environment: Environment,
  fetchImplementation: typeof fetch = fetch,
): Authentication {
  const clientId = environment.GITHUB_CLIENT_ID;
  const clientSecret = environment.GITHUB_CLIENT_SECRET;
  const sessionSecret = environment.SESSION_SECRET;
  if (!clientId || !clientSecret || !sessionSecret) {
    throw new Error("GitHub authentication requires client credentials and a session secret");
  }

  return {
    register(app) {
      app.get("/auth/github", async (request, response) => {
        const state = randomToken();
        const verifier = randomToken(48);
        const now = new Date();
        const oauthState: OAuthStateDocument = {
          _id: hashToken(state),
          codeVerifier: verifier,
          // biome-ignore lint/complexity/useLiteralKeys: Express query is an index signature.
          returnTo: safeReturnTo(request.query["returnTo"]),
          createdAt: now,
          expiresAt: new Date(now.getTime() + OAUTH_STATE_LIFETIME_MS),
        };
        await db.collection<OAuthStateDocument>(collections.oauthStates).insertOne(oauthState);

        const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
        authorizeUrl.searchParams.set("client_id", clientId);
        authorizeUrl.searchParams.set("redirect_uri", callbackUrl(environment));
        authorizeUrl.searchParams.set("scope", "read:user user:email");
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        response.redirect(302, authorizeUrl.toString());
      });

      app.get("/auth/github/callback", async (request, response) => {
        const callback = OAuthCallbackSchema.safeParse(request.query);
        if (!callback.success) {
          response.redirect(303, "/login?error=invalid_oauth_callback");
          return;
        }

        const now = new Date();
        const state = await db
          .collection<OAuthStateDocument>(collections.oauthStates)
          .findOneAndDelete({
            _id: hashToken(callback.data.state),
            expiresAt: { $gt: now },
          });
        if (!state) {
          response.redirect(303, "/login?error=expired_oauth_state");
          return;
        }

        try {
          const tokenResponse = await fetchImplementation(
            "https://github.com/login/oauth/access_token",
            {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code: callback.data.code,
                redirect_uri: callbackUrl(environment),
                code_verifier: state.codeVerifier,
              }),
            },
          );
          const token = GithubTokenSchema.parse(await readJson(tokenResponse));

          const githubHeaders = {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token.access_token}`,
            "x-github-api-version": GITHUB_API_VERSION,
          };
          const [userResponse, emailResponse] = await Promise.all([
            fetchImplementation("https://api.github.com/user", { headers: githubHeaders }),
            fetchImplementation("https://api.github.com/user/emails?per_page=100", {
              headers: githubHeaders,
            }),
          ]);
          const githubUser = GithubUserSchema.parse(await readJson(userResponse));
          const githubEmails = GithubEmailSchema.parse(await readJson(emailResponse));
          const primaryEmail =
            githubEmails.find((email) => email.primary && email.verified)?.email ??
            githubEmails.find((email) => email.verified)?.email ??
            githubUser.email ??
            undefined;

          const user = await db.collection<UserDocument>(collections.users).findOneAndUpdate(
            { githubId: githubUser.id },
            {
              $set: {
                login: githubUser.login,
                name: githubUser.name ?? githubUser.login,
                ...(primaryEmail ? { email: primaryEmail } : {}),
                avatarUrl: githubUser.avatar_url,
                encryptedAccessToken: encryptSecret(token.access_token, sessionSecret),
                updatedAt: now,
                lastLoginAt: now,
              },
              $setOnInsert: { roles: ["participant"], createdAt: now },
            },
            { upsert: true, returnDocument: "after" },
          );
          if (!user) throw new Error("GitHub user could not be saved");

          await db.collection<PersonDocument>(collections.people).updateOne(
            { userId: user._id },
            {
              $set: {
                name: user.name,
                ...(user.email ? { email: user.email } : {}),
                github: user.login,
                verified: true,
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now },
            },
            { upsert: true },
          );

          await destroySession(db, request, response, isSecure(environment));
          await createSession(db, user._id, response, isSecure(environment));
          response.redirect(303, state.returnTo);
        } catch (error) {
          console.error(
            "GitHub OAuth callback failed",
            error instanceof Error ? error.message : "unknown error",
          );
          response.redirect(303, "/login?error=github_auth_failed");
        }
      });

      app.post("/auth/github/revoke", async (request, response) => {
        if (!trustedOrigin(request, environment)) {
          response
            .status(403)
            .json({ error: "untrusted_origin", message: "Request origin is not allowed" });
          return;
        }
        const current = await readCurrentUser(db, request);
        if (!current) {
          response
            .status(401)
            .json({ error: "authentication_required", message: "Sign in to revoke access" });
          return;
        }
        const users = db.collection<UserDocument>(collections.users);
        const user = await users.findOne({ _id: ObjectId.createFromHexString(current.id) });
        if (!user) {
          response
            .status(401)
            .json({ error: "account_not_found", message: "Account session is no longer valid" });
          return;
        }
        try {
          await revokeGithubToken(environment, user.encryptedAccessToken, fetchImplementation);
        } catch (error) {
          // Keep the stored token: telling the person access is gone while GitHub still honours
          // the grant would be a lie. They can retry, or revoke it in GitHub settings.
          console.error(
            "GitHub token revocation failed",
            error instanceof Error ? error.message : "unknown error",
          );
          response.status(502).json({
            error: "github_revoke_failed",
            message: "GitHub did not confirm the revocation; try again",
          });
          return;
        }
        await users.updateOne(
          { _id: user._id },
          { $unset: { encryptedAccessToken: "" }, $set: { updatedAt: new Date() } },
        );
        await destroyAllSessions(db, user._id, response, isSecure(environment));
        response.status(204).end();
      });

      app.post("/auth/logout", async (request, response) => {
        if (!trustedOrigin(request, environment)) {
          response
            .status(403)
            .json({ error: "untrusted_origin", message: "Request origin is not allowed" });
          return;
        }
        await destroySession(db, request, response, isSecure(environment));
        response.status(204).end();
      });
    },

    currentUser(request) {
      return readCurrentUser(db, request);
    },
  };
}
