import { investorPickCreateInputSchema } from "@asi/contracts";
import type { NextRequest } from "next/server";

import { jsonSuccess } from "@/lib/api";
import { requireRole, requireUser, verifyCsrfRequest } from "@/lib/auth";
import {
  createInvestorPickForAdmin,
  listInvestorPicksForUser,
} from "@/lib/investor-picks.server";

import {
  handleInvestorPicksRouteError,
  investorPicksJsonError,
  NO_STORE_HEADERS,
} from "./shared";

export const dynamic = "force-dynamic";


function parseIncludeInactive(request: NextRequest): boolean | Response {
  const values = request.nextUrl.searchParams.getAll("includeInactive");
  if (values.length > 1) {
    return investorPicksJsonError(
      "bad_request",
      "includeInactive may be supplied only once",
      400,
    );
  }
  if (values.length === 0 || values[0] === "false") return false;
  if (values[0] === "true") return true;

  return investorPicksJsonError(
    "bad_request",
    "includeInactive must be true or false",
    400,
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const user = await requireUser();
    const includeInactive = parseIncludeInactive(request);
    if (includeInactive instanceof Response) return includeInactive;
    if (includeInactive && user.role !== "admin") {
      return investorPicksJsonError(
        "forbidden",
        "Only administrators may view archived investor picks",
        403,
      );
    }

    const page = await listInvestorPicksForUser({
      canManage: user.role === "admin",
      ...(includeInactive ? { includeInactive: true } : {}),
    });
    return jsonSuccess(page, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return handleInvestorPicksRouteError(error);
  }
}

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
    const input = investorPickCreateInputSchema.safeParse(body);
    if (!input.success) {
      return investorPicksJsonError(
        "validation_failed",
        "Invalid investor pick",
        400,
        input.error.flatten(),
      );
    }

    const pick = await createInvestorPickForAdmin({
      input: input.data,
      actor: { kind: "admin", userId: user.id },
    });
    return jsonSuccess(pick, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    return handleInvestorPicksRouteError(error);
  }
}
