import { getPool } from "@asi/database/client";

import { jsonError, jsonSuccess } from "@/lib/api";

export const dynamic = "force-dynamic";

const READINESS_TIMEOUT_MS = 2_000;
const SERVICE_VERSION = "1.0.0";

async function checkDatabase(): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const query = getPool().query("select 1");
  void query.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Database readiness check timed out")),
      READINESS_TIMEOUT_MS,
    );
    timeout.unref();
  });

  try {
    await Promise.race([query, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function GET() {
  try {
    await checkDatabase();

    return jsonSuccess(
      { status: "ok" as const, version: SERVICE_VERSION },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError("internal_error", "Service unavailable", 503);
  }
}
