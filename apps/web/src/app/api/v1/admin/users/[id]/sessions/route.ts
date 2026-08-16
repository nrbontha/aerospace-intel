import { uuidSchema } from "@asi/contracts";
import { auditEvents, sessions, users } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { jsonError, jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

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

export async function DELETE(
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

    const result = await getDatabase().transaction(async (tx) => {
      const [target] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId.data))
        .limit(1)
        .for("update");
      if (target === undefined) return undefined;

      const revokedAt = new Date();
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt })
        .where(and(eq(sessions.userId, target.id), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });
      await tx.insert(auditEvents).values({
        actorUserId: actor.id,
        action: "admin.user.sessions_revoked",
        entityType: "user",
        entityId: target.id,
        requestId: request.headers.get("x-request-id"),
        after: { revokedSessionCount: revoked.length },
        metadata: {},
      });
      return revoked.length;
    });

    return result === undefined
      ? jsonError("not_found", "User not found", 404)
      : jsonSuccess({ revokedSessionCount: result });
  } catch (error) {
    return handleRouteError(error);
  }
}
