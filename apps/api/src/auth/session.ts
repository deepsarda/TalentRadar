import type { Request, Response } from "express";
import type { Db, ObjectId } from "mongodb";
import type { SessionDocument, UserDocument } from "../database/models.js";
import { collections } from "../database/mongo.js";
import { hashToken, randomToken } from "./crypto.js";

const SESSION_COOKIE = "tr_session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface CurrentUser {
  id: string;
  githubId: number;
  login: string;
  name: string;
  email?: string;
  avatarUrl: string;
  roles: UserDocument["roles"];
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function serializeCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export async function createSession(
  db: Db,
  userId: ObjectId,
  response: Response,
  secure: boolean,
): Promise<void> {
  const now = new Date();
  const rawToken = randomToken();
  const session: SessionDocument = {
    _id: hashToken(rawToken),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
  };

  await db.collection<SessionDocument>(collections.sessions).insertOne(session);
  response.setHeader("set-cookie", serializeCookie(rawToken, SESSION_LIFETIME_MS / 1000, secure));
}

export async function destroySession(
  db: Db,
  request: Request,
  response: Response,
  secure: boolean,
): Promise<void> {
  const rawToken = cookieValue(request, SESSION_COOKIE);
  if (rawToken) {
    await db
      .collection<SessionDocument>(collections.sessions)
      .deleteOne({ _id: hashToken(rawToken) });
  }
  response.setHeader("set-cookie", serializeCookie("", 0, secure));
}

export async function readCurrentUser(db: Db, request: Request): Promise<CurrentUser | null> {
  const rawToken = cookieValue(request, SESSION_COOKIE);
  if (!rawToken) return null;

  const now = new Date();
  const session = await db
    .collection<SessionDocument>(collections.sessions)
    .findOneAndUpdate(
      { _id: hashToken(rawToken), expiresAt: { $gt: now } },
      { $set: { lastSeenAt: now } },
      { returnDocument: "after" },
    );
  if (!session) return null;

  const user = await db
    .collection<UserDocument>(collections.users)
    .findOne({ _id: session.userId });
  if (!user) return null;
  return {
    id: user._id.toHexString(),
    githubId: user.githubId,
    login: user.login,
    name: user.name,
    ...(user.email ? { email: user.email } : {}),
    avatarUrl: user.avatarUrl,
    roles: user.roles,
  };
}
