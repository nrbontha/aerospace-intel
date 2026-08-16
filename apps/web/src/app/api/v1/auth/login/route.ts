import { loginSchema } from "@asi/contracts";
import { getDatabase } from "@asi/database/client";
import { auditEvents, users } from "@asi/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  createSession,
  hashPassword,
  revokeSession,
  verifyPassword,
} from "@/lib/auth";
import { consumeLoginRateLimit, resetLoginRateLimit } from "@/lib/rate-limit";

const INVALID_CREDENTIALS = "Invalid email or password.";
const DUMMY_PASSWORD = "not-a-real-account-password";

let dummyPasswordHashPromise: Promise<string> | undefined;

function dummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword(DUMMY_PASSWORD);
  return dummyPasswordHashPromise;
}

function errorResponse(
  code: "bad_request" | "unauthorized" | "rate_limited" | "internal_error",
  message: string,
  status: number,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: responseHeaders },
  );
}

function requestId(request: Request): string | null {
  const value = request.headers.get("x-request-id")?.trim();
  return value === undefined || value.length === 0 ? null : value.slice(0, 500);
}

function clientAddress(request: Request): string {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim();
  const value =
    forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  return value.slice(0, 256);
}

async function auditLogin(
  request: Request,
  outcome: "success" | "failure",
  userId: string | null,
  reason:
    | "authenticated"
    | "invalid_request"
    | "invalid_credentials"
    | "rate_limited",
) {
  await getDatabase()
    .insert(auditEvents)
    .values({
      actorUserId: outcome === "success" ? userId : null,
      action: `auth.login.${outcome}`,
      entityType: "user",
      entityId: outcome === "success" ? userId : null,
      requestId: requestId(request),
      metadata: { outcome, reason },
    });
}

export async function POST(request: Request) {
  let sessionCreated = false;

  try {
    let body: unknown;

    try {
      body = await request.json();
    } catch {
      await auditLogin(request, "failure", null, "invalid_request");
      return errorResponse("bad_request", "Invalid login request.", 400);
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      await auditLogin(request, "failure", null, "invalid_request");
      return errorResponse("bad_request", "Invalid login request.", 400);
    }

    const email = parsed.data.email.toLowerCase();
    const rateLimitSubject = `${email}\u0000${clientAddress(request)}`;
    const rateLimit = await consumeLoginRateLimit(rateLimitSubject);

    if (!rateLimit.allowed) {
      await auditLogin(request, "failure", null, "rate_limited");
      return errorResponse(
        "rate_limited",
        "Unable to sign in. Please try again later.",
        429,
        { "retry-after": String(rateLimit.retryAfterSeconds) },
      );
    }

    const database = getDatabase();
    const [user] = await database
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        role: users.role,
        isDisabled: users.isDisabled,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(
        and(sql`lower(${users.email}) = ${email}`, eq(users.isDisabled, false)),
      )
      .limit(1);

    const passwordHash = user?.passwordHash ?? (await dummyPasswordHash());
    const passwordMatches = await verifyPassword(
      parsed.data.password,
      passwordHash,
    ).catch(() => false);

    if (user === undefined || !passwordMatches) {
      await auditLogin(request, "failure", null, "invalid_credentials");
      return errorResponse("unauthorized", INVALID_CREDENTIALS, 401);
    }

    await resetLoginRateLimit(rateLimitSubject);
    await createSession(user.id, request);
    sessionCreated = true;

    await auditLogin(request, "success", user.id, "authenticated");

    return NextResponse.json(
      {
        data: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          disabled: user.isDisabled,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    if (sessionCreated) {
      await revokeSession().catch(() => undefined);
    }

    return errorResponse("internal_error", "Unable to complete sign in.", 500);
  }
}
