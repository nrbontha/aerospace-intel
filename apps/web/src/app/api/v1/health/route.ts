import { jsonSuccess } from "@/lib/api";

export const dynamic = "force-dynamic";

const SERVICE_VERSION = "1.0.0";

export function GET() {
  return jsonSuccess(
    { status: "ok" as const, version: SERVICE_VERSION },
    { headers: { "Cache-Control": "no-store" } },
  );
}
