import type { NextFunction, Request, RequestHandler, Response } from "express";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defence for cookie sessions: SameSite=Lax is the first layer, this is the second.
 * A state-changing request is refused when the browser says it came from another site.
 *
 * - `Origin` present: it must be the configured app origin or the host the request was sent to
 *   (the Vite dev proxy keeps the page's Host, so same-origin dev works without configuration).
 * - `Origin` absent: refuse only when `Sec-Fetch-Site: cross-site`. Non-browser clients
 *   (curl, tests, health checks) send neither header and are not a CSRF vector.
 */
export function originGuard(allowedOrigins: string[] = []): RequestHandler {
  const allowed = new Set(allowedOrigins.map((origin) => origin.replace(/\/$/, "")));

  return (request: Request, response: Response, next: NextFunction) => {
    if (!UNSAFE_METHODS.has(request.method)) return next();

    const origin = request.get("origin");
    if (origin) {
      if (allowed.has(origin)) return next();
      try {
        if (new URL(origin).host === request.get("host")) return next();
      } catch {
        // Malformed Origin (including the literal "null"): fall through to refusal.
      }
      return refuse(response);
    }

    if (request.get("sec-fetch-site") === "cross-site") return refuse(response);
    return next();
  };
}

function refuse(response: Response): void {
  response.status(403).json({
    error: "cross_site_request",
    message: "This request was blocked because it came from another site",
  });
}

export interface RateLimitOptions {
  /** Requests allowed per client per window. */
  limit: number;
  windowMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window limiter keyed by client IP. In-memory: right for one free-tier instance. */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;

  return (request: Request, response: Response, next: NextFunction) => {
    const time = now();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= time) buckets.delete(key);
    }

    const key = request.ip ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= time) {
      bucket = { count: 0, resetAt: time + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, options.limit - bucket.count);
    response.setHeader("RateLimit-Limit", String(options.limit));
    response.setHeader("RateLimit-Remaining", String(remaining));

    if (bucket.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - time) / 1000));
      response.setHeader("Retry-After", String(retryAfter));
      response.status(429).json({
        error: "rate_limited",
        message: `Too many requests. Try again in ${retryAfter} seconds`,
      });
      return;
    }
    next();
  };
}
