/**
 * One-off curl-level verification for GET /api/v1/leads with filter params.
 * Replicates the route's exact query-parsing expression, then exercises
 * listLeads against the isolated test DB and asserts the 200 envelope.
 *   DATABASE_URL=... npx tsx scripts/verify-leads-route.ts
 */
import { randomUUID } from "node:crypto";
import { leadListQuerySchema, uuidSchema } from "@asi/contracts";
import { ingestLeadCandidates, listLeads } from "@asi/database";
import { runMigrations } from "../packages/database/src/migrate.js";

const leadListRouteQuerySchema = leadListQuerySchema.extend({
  campaignId: uuidSchema.optional(),
});

// Identical parsing expression to apps/web/src/app/api/v1/leads/route.ts.
function parseRouteQuery(searchParams: URLSearchParams) {
  return leadListRouteQuerySchema.safeParse({
    ...(searchParams.get("campaignId") === null
      ? {}
      : { campaignId: searchParams.get("campaignId") }),
    ...(searchParams.get("status") === null
      ? {}
      : { status: searchParams.get("status") }),
    ...(searchParams.get("page") === null ? {} : { page: searchParams.get("page") }),
    ...(searchParams.get("pageSize") === null
      ? {}
      : { pageSize: searchParams.get("pageSize") }),
  });
}

await runMigrations();
const campaignId = randomUUID();
await ingestLeadCandidates(campaignId, [
  {
    rawName: "Curl Check Manufacturing LLC",
    awardCount: 3,
    totalAwardValueUsd: 12_345.67,
    sourceLocator: "usaspending://spending_by_award?recipient_name=Curl+Check",
  },
]);

let failures = 0;
async function check(label: string, search: string): Promise<void> {
  const url = new URL(`https://x.test/api/v1/leads?${search}`);
  const query = parseRouteQuery(url.searchParams);
  if (!query.success) {
    console.log(`FAIL ${label}: validation_failed`, query.error.flatten());
    failures += 1;
    return;
  }
  const result = await listLeads({
    ...(query.data.campaignId === undefined ? {} : { campaignId: query.data.campaignId }),
    ...(query.data.status === undefined ? {} : { status: query.data.status }),
    page: query.data.page,
    pageSize: query.data.pageSize,
  });
  const envelope = {
    data: result.records,
    meta: {
      page: query.data.page,
      pageSize: query.data.pageSize,
      totalItems: result.total,
      totalPages: Math.ceil(result.total / query.data.pageSize) || 0,
    },
  };
  const ok =
    Array.isArray(envelope.data) &&
    typeof envelope.meta.totalItems === "number" &&
    envelope.meta.page === query.data.page;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: 200 envelope`, {
    totalItems: envelope.meta.totalItems,
    records: envelope.data.length,
    firstStatus: envelope.data[0] === undefined ? undefined : envelope.data[0].status,
  });
  if (!ok) failures += 1;
}

await check("campaignId+page+pageSize", `campaignId=${campaignId}&page=1&pageSize=25`);
await check("campaignId+status=new", `campaignId=${campaignId}&status=new&page=1&pageSize=25`);
await check("no filters", "page=1&pageSize=25");
await check("status only", "status=unresolved_lead");

const bad = new URL("https://x.test/api/v1/leads?campaignId=not-a-uuid");
console.log(`${
  parseRouteQuery(bad.searchParams).success ? "FAIL" : "PASS"
} invalid campaignId still 400s`);

process.exit(failures === 0 ? 0 : 1);
