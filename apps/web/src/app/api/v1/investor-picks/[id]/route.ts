import {
  investorPickUpdateInputSchema,
  uuidSchema,
} from "@asi/contracts";
import type { NextRequest } from "next/server";

import { jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { updateInvestorPickForAdmin } from "@/lib/investor-picks.server";

import {
  handleInvestorPicksRouteError,
  investorPicksJsonError,
  NO_STORE_HEADERS,
} from "../shared";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    const user = await requireRole("admin");
    await verifyCsrfRequest(request);

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return investorPicksJsonError(
        "validation_failed",
        "Invalid investor pick id",
        400,
        id.error.flatten(),
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return investorPicksJsonError(
        "bad_request",
        "Request body must be valid JSON",
        400,
      );
    }
    const input = investorPickUpdateInputSchema.safeParse(body);
    if (!input.success) {
      return investorPicksJsonError(
        "validation_failed",
        "Invalid investor pick update",
        400,
        input.error.flatten(),
      );
    }

    const pick = await updateInvestorPickForAdmin({
      id: id.data,
      input: input.data,
      actor: { kind: "admin", userId: user.id },
    });
    return jsonSuccess(pick, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return handleInvestorPicksRouteError(error);
  }
}
