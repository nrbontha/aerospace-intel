import { openApiDocument } from "@asi/contracts";
import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();

    if (user === null) {
      return jsonError("unauthorized", "Authentication required", 401);
    }

    return NextResponse.json(openApiDocument, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return jsonError("internal_error", "Unable to load API definition", 500);
  }
}
