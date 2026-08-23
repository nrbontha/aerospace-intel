import { Suspense } from "react";

import { CampaignDetailView } from "@/components/campaigns/campaign-detail";
import { requireUser } from "@/lib/auth";

export const metadata = {
  title: "Campaign | ASI",
};

type PageProps = { params: Promise<{ id: string }> };

export default async function CampaignDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireUser();
  const canOperate = user.role === "analyst" || user.role === "admin";

  return (
    <Suspense
      fallback={
        <div className="admin-panel" role="status">
          Loading campaign…
        </div>
      }
    >
      <CampaignDetailView campaignId={id} canOperate={canOperate} />
    </Suspense>
  );
}
