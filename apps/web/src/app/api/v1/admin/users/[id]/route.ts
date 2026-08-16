import {
  userUpdateSchema,
  uuidSchema,
  type Role,
  type User,
} from "@asi/contracts";
import { auditEvents, users } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, count, eq, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
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

type RouteContext = { params: Promise<{ id: string }> };

class LastActiveAdminError extends Error {}

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

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof LastActiveAdminError) {
    return jsonError(
      "conflict",
      "The last active administrator cannot disable or demote their own account",
      409,
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

async function validatedId(
  context: RouteContext,
): Promise<{ id: string } | Response> {
  const parsed = uuidSchema.safeParse((await context.params).id);
  return parsed.success
    ? { id: parsed.data }
    : jsonError("validation_failed", "Invalid user id", 400);
}

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireRole("admin");
    const target = await validatedId(context);
    if (target instanceof Response) return target;

    const [row] = await getDatabase()
      .select(publicUserSelection)
      .from(users)
      .where(eq(users.id, target.id))
      .limit(1);
    return row === undefined
      ? jsonError("not_found", "User not found", 404)
      : jsonSuccess(serializeUser(row));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("admin");
    await verifyCsrfRequest(request);
    const target = await validatedId(context);
    if (target instanceof Response) return target;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const input = userUpdateSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid user update",
        400,
        input.error.flatten(),
      );
    }

    const updated = await getDatabase().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('asi.admin.user_roles'))`,
      );
      const [existing] = await tx
        .select(publicUserSelection)
        .from(users)
        .where(eq(users.id, target.id))
        .limit(1)
        .for("update");
      if (existing === undefined) return undefined;

      const nextRole = input.data.role ?? existing.role;
      const nextDisabled = input.data.disabled ?? existing.isDisabled;
      const removesOwnActiveAdmin =
        existing.id === actor.id &&
        existing.role === "admin" &&
        !existing.isDisabled &&
        (nextRole !== "admin" || nextDisabled);
      if (removesOwnActiveAdmin) {
        const [activeAdminTotal] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, "admin"), eq(users.isDisabled, false)));
        if ((activeAdminTotal?.value ?? 0) <= 1) {
          throw new LastActiveAdminError();
        }
      }

      const changes: {
        updatedAt: Date;
        displayName?: string;
        role?: Role;
        isDisabled?: boolean;
      } = { updatedAt: new Date() };
      if (input.data.displayName !== undefined) {
        changes.displayName = input.data.displayName;
      }
      if (input.data.role !== undefined) changes.role = input.data.role;
      if (input.data.disabled !== undefined) {
        changes.isDisabled = input.data.disabled;
      }

      const [row] = await tx
        .update(users)
        .set(changes)
        .where(eq(users.id, target.id))
        .returning(publicUserSelection);
      if (row === undefined) throw new Error("User update returned no row");

      const before = serializeUser(existing);
      const after = serializeUser(row);
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        action: "admin.user.updated",
        entityType: "user",
        entityId: row.id,
        requestId: request.headers.get("x-request-id"),
        before,
        after,
        metadata: {},
      });
      return after;
    });

    return updated === undefined
      ? jsonError("not_found", "User not found", 404)
      : jsonSuccess(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
