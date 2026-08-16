import { NextResponse } from "next/server";

import { CSRF_COOKIE_NAME, requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export async function GET() {
  try {
    const user = await requireUser();

    return NextResponse.json(
      {
        data: {
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
          },
          csrf: {
            cookieName: CSRF_COOKIE_NAME,
            headerName: "x-csrf-token",
          },
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(
        {
          error: {
            code: "unauthorized",
            message: "Authentication required.",
          },
        },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        error: {
          code: "internal_error",
          message: "Unable to load the current user.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
