import { getOperationsSnapshot } from "@asi/database";
import { getServerEnv } from "@asi/config";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await requireRole("admin");
    const env = getServerEnv();
    const snapshot = await getOperationsSnapshot(env.STORAGE_PATH);
    return jsonSuccess(jsonValue(snapshot), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError(
        error.status === 401 ? "unauthorized" : "forbidden",
        error.message,
        error.status,
      );
    }
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
