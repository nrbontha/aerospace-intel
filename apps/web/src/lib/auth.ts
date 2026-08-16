import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { hash, verify } from "@node-rs/argon2";
import type { Role } from "@asi/contracts";
import { getServerEnv } from "@asi/config";
import { sessions, users } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, eq, gt, isNull } from "drizzle-orm";
import { cookies } from "next/headers";

import { assertRole, AuthorizationError } from "./rbac";

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_REFRESH_THRESHOLD_MS = SESSION_DURATION_MS / 2;
const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60 * 1_000;
const TOKEN_BYTES = 32;

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME?.trim() || "asi_session";
export const CSRF_COOKIE_NAME = `${SESSION_COOKIE_NAME}_csrf`;

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function secretHash(value: string): string | null {
  const secret = getServerEnv().SESSION_SECRET;
  if (secret === undefined) {
    return null;
  }
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function equalStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function cookieOptions(expires: Date, httpOnly: boolean) {
  const env = getServerEnv();
  return {
    expires,
    httpOnly,
    path: "/",
    sameSite: "lax" as const,
    secure: env.SESSION_COOKIE_SECURE,
  };
}

async function expireAuthCookies(): Promise<void> {
  const cookieStore = await cookies();
  const expires = new Date(0);
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    ...cookieOptions(expires, true),
    maxAge: 0,
  });
  cookieStore.set(CSRF_COOKIE_NAME, "", {
    ...cookieOptions(expires, false),
    maxAge: 0,
  });
}

async function findActiveSession(token: string, now: Date) {
  const tokenHash = digestToken(token);
  const [record] = await getDatabase()
    .select({
      sessionId: sessions.id,
      csrfTokenHash: sessions.csrfTokenHash,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        eq(users.isDisabled, false),
      ),
    )
    .limit(1);

  return record;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) {
    throw new Error("Password must not be empty");
  }

  return hash(password, {
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  if (password.length === 0 || passwordHash.length === 0) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function createSession(
  userId: string,
  request?: Request,
): Promise<{ expiresAt: Date }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  const sessionToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const csrfToken = randomBytes(TOKEN_BYTES).toString("base64url");
  const forwardedFor = request?.headers
    .get("x-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim();
  const directIp = request?.headers.get("x-real-ip")?.trim();
  const ipAddress = forwardedFor || directIp;
  const userAgent = request?.headers.get("user-agent")?.slice(0, 1_024);
  const database = getDatabase();

  await database.transaction(async (transaction) => {
    const [activeUser] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isDisabled, false)))
      .limit(1);

    if (activeUser === undefined) {
      throw new AuthorizationError(
        401,
        "UNAUTHORIZED",
        "Authentication is required",
      );
    }

    await transaction.insert(sessions).values({
      userId,
      tokenHash: digestToken(sessionToken),
      csrfTokenHash: digestToken(csrfToken),
      expiresAt,
      lastSeenAt: now,
      ipHash: ipAddress === undefined ? null : secretHash(ipAddress),
      userAgent: userAgent || null,
    });
    await transaction
      .update(users)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(users.id, userId));
  });

  const cookieStore = await cookies();
  cookieStore.set(
    SESSION_COOKIE_NAME,
    sessionToken,
    cookieOptions(expiresAt, true),
  );
  cookieStore.set(CSRF_COOKIE_NAME, csrfToken, cookieOptions(expiresAt, false));

  return { expiresAt };
}

export async function revokeSession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (sessionToken !== undefined && sessionToken.length > 0) {
    await getDatabase()
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.tokenHash, digestToken(sessionToken)),
          isNull(sessions.revokedAt),
        ),
      );
  }

  await expireAuthCookies();
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await getDatabase()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function getCurrentUser(): Promise<{
  id: string;
  email: string;
  displayName: string;
  role: Role;
} | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined || sessionToken.length === 0) {
    return null;
  }

  const now = new Date();
  const record = await findActiveSession(sessionToken, now);
  if (record === undefined) {
    return null;
  }

  const lastSeenIsStale =
    record.lastSeenAt === null ||
    now.getTime() - record.lastSeenAt.getTime() >= LAST_SEEN_UPDATE_INTERVAL_MS;
  const shouldExtend =
    record.expiresAt.getTime() - now.getTime() <= SESSION_REFRESH_THRESHOLD_MS;

  if (lastSeenIsStale || shouldExtend) {
    const nextExpiry = shouldExtend
      ? new Date(now.getTime() + SESSION_DURATION_MS)
      : record.expiresAt;
    await getDatabase()
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: nextExpiry })
      .where(
        and(
          eq(sessions.id, record.sessionId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      );

    if (shouldExtend) {
      try {
        cookieStore.set(
          SESSION_COOKIE_NAME,
          sessionToken,
          cookieOptions(nextExpiry, true),
        );
        const csrfToken = cookieStore.get(CSRF_COOKIE_NAME)?.value;
        if (csrfToken !== undefined) {
          cookieStore.set(
            CSRF_COOKIE_NAME,
            csrfToken,
            cookieOptions(nextExpiry, false),
          );
        }
      } catch {
        // Server Components cannot mutate cookies; the database session still slides.
      }
    }
  }

  return {
    id: record.userId,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
  };
}

export async function requireUser(): Promise<{
  id: string;
  email: string;
  displayName: string;
  role: Role;
}> {
  const user = await getCurrentUser();
  if (user === null) {
    throw new AuthorizationError(
      401,
      "UNAUTHORIZED",
      "Authentication is required",
    );
  }
  return user;
}

export async function requireRole(...allowedRoles: Role[]): Promise<{
  id: string;
  email: string;
  displayName: string;
  role: Role;
}> {
  const user = await requireUser();
  assertRole(user.role, allowedRoles);
  return user;
}

export async function verifyCsrfRequest(request: Request): Promise<void> {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    return;
  }

  const origin = request.headers.get("origin");
  let originMatches = false;
  if (origin !== null) {
    try {
      originMatches =
        new URL(origin).origin === new URL(getServerEnv().APP_URL).origin;
    } catch {
      originMatches = false;
    }
  }
  if (!originMatches) {
    throw new AuthorizationError(
      403,
      "INVALID_ORIGIN",
      "The request origin is not allowed",
    );
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const csrfCookie = cookieStore.get(CSRF_COOKIE_NAME)?.value;
  const csrfHeader = request.headers.get("x-csrf-token");
  if (
    sessionToken === undefined ||
    csrfCookie === undefined ||
    csrfHeader === null ||
    !equalStrings(csrfCookie, csrfHeader)
  ) {
    throw new AuthorizationError(
      403,
      "INVALID_CSRF",
      "The CSRF token is invalid",
    );
  }

  const record = await findActiveSession(sessionToken, new Date());
  const suppliedHash = digestToken(csrfHeader);
  if (
    record === undefined ||
    !equalStrings(record.csrfTokenHash, suppliedHash)
  ) {
    throw new AuthorizationError(
      403,
      "INVALID_CSRF",
      "The CSRF token is invalid",
    );
  }
}
