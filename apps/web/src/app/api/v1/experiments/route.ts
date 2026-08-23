import { experimentKindSchema } from "@asi/contracts";
import { getDatabase, listExperimentRuns } from "@asi/database";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { jsonError, jsonSuccess, jsonValue } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

export const dynamic = "force-dynamic";

const limitSchema = z.coerce.number().int().min(1).max(500);
const offsetSchema = z.coerce.number().int().min(0);

function handleRouteError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    return jsonError(
      error.status === 401 ? "unauthorized" : "forbidden",
      error.message,
      error.status,
    );
  }
  return jsonError("internal_error", "An internal error occurred", 500);
}

/** Append-only experiment journal listing (all roles). */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;

    let kind: z.infer<typeof experimentKindSchema> | undefined;
    const kindRaw = params.get("kind");
    if (kindRaw !== null) {
      const parsedKind = experimentKindSchema.safeParse(kindRaw);
      if (!parsedKind.success) {
        return jsonError("validation_failed", "Invalid experiment kind", 400);
      }
      kind = parsedKind.data;
    }

    let keep: boolean | undefined;
    const keepRaw = params.get("keep");
    if (keepRaw !== null && keepRaw !== "") {
      if (keepRaw !== "true" && keepRaw !== "false") {
        return jsonError(
          "validation_failed",
          "keep must be 'true' or 'false'",
          400,
        );
      }
      keep = keepRaw === "true";
    }

    let limit: number | undefined;
    const limitRaw = params.get("limit");
    if (limitRaw !== null) {
      const parsedLimit = limitSchema.safeParse(limitRaw);
      if (!parsedLimit.success) {
        return jsonError("validation_failed", "Invalid limit", 400);
      }
      limit = parsedLimit.data;
    }

    let offset: number | undefined;
    const offsetRaw = params.get("offset");
    if (offsetRaw !== null) {
      const parsedOffset = offsetSchema.safeParse(offsetRaw);
      if (!parsedOffset.success) {
        return jsonError("validation_failed", "Invalid offset", 400);
      }
      offset = parsedOffset.data;
    }

    const { records, total } = await listExperimentRuns(getDatabase(), {
      kind,
      keep,
      label: params.get("label") ?? undefined,
      limit,
      offset,
    });

    return jsonSuccess(jsonValue({ records, total }), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
