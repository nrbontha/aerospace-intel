import type { Metadata } from "next";

import { InvestorPicksAdmin } from "@/components/investor-picks-admin";

export const metadata: Metadata = {
  title: "Golden approvals | ASI",
  description:
    "Manage the single investor-approved Golden collection while preserving original source provenance.",
};

export default function InvestorPicksAdminPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Administration</p>
        <h1 className="asi-page-title">Golden approvals</h1>
        <p className="asi-page-description">
          Manage investor approvals shown by the gold Golden badge in the Investor
          queue. Approval retains original provenance and does not change research
          scores, verified identity, or acquisition qualification.
        </p>
      </header>
      <InvestorPicksAdmin />
    </>
  );
}
