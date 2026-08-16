import { createHmac } from "node:crypto";

import { getServerEnv } from "@asi/config";
import { rateLimits } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, eq, sql } from "drizzle-orm";

const LOGIN_SCOPE = "auth.login";
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 5;

function hashSubject(subject: string): string {
  const secret = getServerEnv().SESSION_SECRET;
  if (secret === undefined) {
    throw new Error("SESSION_SECRET is required for login rate limiting");
  }
  return createHmac("sha256", secret)
    .update(subject.trim().toLowerCase(), "utf8")
    .digest("hex");
}

export async function consumeLoginRateLimit(subject: string): Promise<{
  allowed: boolean;
  retryAfterSeconds: number;
}> {
  if (subject.trim().length === 0) {
    throw new Error("A rate-limit subject is required");
  }

  const now = new Date();
  const windowMilliseconds = LOGIN_WINDOW_SECONDS * 1_000;
  const windowStartedAt = new Date(
    Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds,
  );
  const expiresAt = new Date(windowStartedAt.getTime() + windowMilliseconds);
  const subjectHash = hashSubject(subject);
  const [record] = await getDatabase()
    .insert(rateLimits)
    .values({
      scope: LOGIN_SCOPE,
      subjectHash,
      windowStartedAt,
      windowSeconds: LOGIN_WINDOW_SECONDS,
      requestCount: 1,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        rateLimits.scope,
        rateLimits.subjectHash,
        rateLimits.windowStartedAt,
      ],
      set: {
        requestCount: sql`${rateLimits.requestCount} + 1`,
        updatedAt: now,
      },
    })
    .returning({ requestCount: rateLimits.requestCount });

  if (record === undefined) {
    throw new Error("Failed to record the login rate limit");
  }

  return {
    allowed: record.requestCount <= LOGIN_ATTEMPT_LIMIT,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((expiresAt.getTime() - now.getTime()) / 1_000),
    ),
  };
}

export async function resetLoginRateLimit(subject: string): Promise<void> {
  if (subject.trim().length === 0) {
    return;
  }

  await getDatabase()
    .delete(rateLimits)
    .where(
      and(
        eq(rateLimits.scope, LOGIN_SCOPE),
        eq(rateLimits.subjectHash, hashSubject(subject)),
      ),
    );
}
