import { userCreateSchema, uuidSchema } from "@asi/contracts";
import { auditEvents, users } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { hashPassword, requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

const resetPasswordSchema = userCreateSchema.pick({ password: true });
type RouteContext = { params: Promise<{ id: string }> };

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const actor = await requireRole("admin");
    await verifyCsrfRequest(request);

    const targetId = uuidSchema.safeParse((await context.params).id);
    if (!targetId.success) {
      return jsonError("validation_failed", "Invalid user id", 400);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("bad_request", "Request body must be valid JSON", 400);
    }
    const input = resetPasswordSchema.safeParse(body);
    if (!input.success) {
      return jsonError(
        "validation_failed",
        "Invalid password",
        400,
        input.error.flatten(),
      );
    }

    const passwordHash = await hashPassword(input.data.password);
    const changed = await getDatabase().transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId.data))
        .limit(1)
        .for("update");
      if (target === undefined) return false;

      await tx
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, target.id));
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        action: "admin.user.password_reset",
        entityType: "user",
        entityId: target.id,
        requestId: request.headers.get("x-request-id"),
        after: { passwordReset: true },
        metadata: {},
      });
      return true;
    });

    return changed
      ? jsonSuccess({ reset: true })
      : jsonError("not_found", "User not found", 404);
  } catch (error) {
    return handleRouteError(error);
  }
}
