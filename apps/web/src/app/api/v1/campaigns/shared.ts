import {
  CampaignNotFoundError,
  CampaignStartPreconditionError,
  IllegalCampaignTransitionError,
} from "@asi/research";

import { jsonError } from "@/lib/api";
import { AuthorizationError } from "@/lib/rbac";

export function handleCampaignRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  if (error instanceof CampaignNotFoundError) {
    return jsonError("not_found", error.message, 404);
  }
  if (
    error instanceof IllegalCampaignTransitionError ||
    error instanceof CampaignStartPreconditionError
  ) {
    return jsonError("conflict", error.message, 409);
  }
  if (isUniqueViolation(error)) {
    return jsonError("conflict", "A campaign with that name already exists", 409);
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "23505";
}
