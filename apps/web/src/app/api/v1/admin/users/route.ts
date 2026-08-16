import {
  paginatedQuerySchema,
  userCreateSchema,
  type User,
} from "@asi/contracts";
import { auditEvents, users } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { asc, count } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { hashPassword, requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

const publicUserSelection = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  isDisabled: users.isDisabled,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

type PublicUserRow = {
  id: string;
  email: string;
  displayName: string;
  role: User["role"];
  isDisabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function serializeUser(row: PublicUserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    disabled: row.isDisabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return postgresErrorCode(error.cause);
  return undefined;
}

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (postgresErrorCode(error) === "23505") {
    return jsonError("conflict", "A user with that email already exists", 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireRole("admin");

    const query = paginatedQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    if (!query.success) {
      return jsonError(
        "validation_failed",
        "Invalid pagination parameters",
        400,
        query.error.flatten(),
      );
    }

    const { page, pageSize } = query.data;
    const db = getDatabase();
    const [rows, totals] = await Promise.all([
      db
        .select(publicUserSelection)
        .from(users)
        .orderBy(asc(users.email))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ value: count() }).from(users),
    ]);
    const totalItems = totals[0]?.value ?? 0;

    return NextResponse.json({
      data: rows.map(serializeUser),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const actor = await requireRole("admin");
    await verifyCsrfRequest(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }

    const input = userCreateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid user",
        400,
        input.error.flatten(),
      );
    }

    const passwordHash = await hashPassword(input.data.password);
    const email = input.data.email.toLowerCase();
    const db = getDatabase();
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          email,
          displayName: input.data.displayName,
          passwordHash,
          role: input.data.role,
        })
        .returning(publicUserSelection);
      if (row === undefined) throw new Error("User insert returned no row");

      const publicUser = serializeUser(row);
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        action: "admin.user.created",
        entityType: "user",
        entityId: row.id,
        requestId: request.headers.get("x-request-id"),
        after: publicUser,
        metadata: {},
      });
      return publicUser;
    });

    return jsonSuccess(created, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
