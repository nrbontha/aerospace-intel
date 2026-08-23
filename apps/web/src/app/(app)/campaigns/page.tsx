import { Suspense } from "react";

import { CampaignsExplorer } from "@/components/campaigns/campaigns-explorer";
import { requireUser } from "@/lib/auth";

export const metadata = {
  title: "Campaigns | ASI",
  description:
    "Research campaigns: discovery frontiers, lifecycle control, spend, and lead output.",
};

export default async function CampaignsPage() {
  const user = await requireUser();
  const canOperate = user.role === "analyst" || user.role === "admin";

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Discovery operations</p>
        <h1 className="asi-page-title">Campaigns</h1>
        <p className="asi-page-description">
          Every research campaign with its lifecycle state, spend against
          budget, and frontier progress. Campaigns start empty: seed the
          frontier before starting.
        </p>
      </header>
      <Suspense
        fallback={
          <div className="admin-panel" role="status">
            Loading campaigns…
          </div>
        }
      >
        <CampaignsExplorer canOperate={canOperate} />
      </Suspense>
    </>
  );
}
