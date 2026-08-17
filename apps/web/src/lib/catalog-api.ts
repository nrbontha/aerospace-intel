import { jsonError } from "@/lib/api";
import { AuthorizationError } from "@/lib/rbac";

export function handleCatalogRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}
