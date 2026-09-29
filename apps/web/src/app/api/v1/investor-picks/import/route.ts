import { investorReferenceImportInputSchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { jsonSuccess } from "@/lib/api";
import { requireRole, verifyCsrfRequest } from "@/lib/auth";
import { importInvestorReferenceSetForAdmin } from "@/lib/investor-picks.server";

import {
  handleInvestorPicksRouteError,
  investorPicksJsonError,
  NO_STORE_HEADERS,
} from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const user = await requireRole("admin");
    await verifyCsrfRequest(request);

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
    const input = investorReferenceImportInputSchema.safeParse(body);
    if (!input.success) {
      return investorPicksJsonError(
        "validation_failed",
        "Invalid investor reference import",
        400,
        input.error.flatten(),
      );
    }

    const result = await importInvestorReferenceSetForAdmin({
      set: input.data.set,
      actor: { kind: "admin", userId: user.id },
    });
    return jsonSuccess(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return handleInvestorPicksRouteError(error);
  }
}
