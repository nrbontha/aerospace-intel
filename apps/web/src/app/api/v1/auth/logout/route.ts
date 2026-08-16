import { NextResponse } from "next/server";

import { requireUser, revokeSession, verifyCsrfRequest } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

function authorizationFailure(error: AuthorizationError) {
  const forbidden = error.status === 403;
  return NextResponse.json(
    {
      error: {
        code: forbidden ? "forbidden" : "unauthorized",
        message: forbidden ? "Request forbidden." : "Authentication required.",
      },
    },
    {
      status: forbidden ? 403 : 401,
      headers: { "cache-control": "no-store" },
    },
  );
}

export async function POST(request: Request) {
  try {
    await requireUser();
    await verifyCsrfRequest(request);
    await revokeSession();

    return new NextResponse(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return authorizationFailure(error);
    }

    return NextResponse.json(
      { error: { code: "internal_error", message: "Unable to sign out." } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
