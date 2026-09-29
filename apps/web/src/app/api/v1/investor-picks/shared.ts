import type { ApiError, ApiErrorCode } from "@asi/contracts";
import { InvestorPicksError } from "@asi/database";

import { jsonError } from "@/lib/api";
import { AuthorizationError } from "@/lib/rbac";

export const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export function investorPicksJsonError(
  code: ApiErrorCode,
  message: string,
  status: number,
  details?: ApiError["details"],
): Response {
  const response = jsonError(code, message, status, details);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function handleInvestorPicksRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return investorPicksJsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }

  if (error instanceof InvestorPicksError) {
    switch (error.code) {
      case "not_found":
        return investorPicksJsonError(
          "not_found",
          "Investor pick not found",
          404,
        );
      case "invalid_input":
        return investorPicksJsonError(
          "validation_failed",
          "Invalid investor pick input",
          400,
        );
      case "reference_unavailable":
        return investorPicksJsonError(
          "conflict",
          "The requested investor reference set is unavailable",
          409,
        );
    }
  }

  return investorPicksJsonError(
    "internal_error",
    "An internal error occurred",
    500,
  );
}
