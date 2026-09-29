import type { Metadata } from "next";

import { InvestorPicksAdmin } from "@/components/investor-picks-admin";

export const metadata: Metadata = {
  title: "Investor picks | ASI",
  description:
    "Administrator-managed investor shortlist with stored Golden, Booie, and manual provenance.",
};

export default function InvestorPicksAdminPage() {
  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Administration</p>
        <h1 className="asi-page-title">Investor picks</h1>
        <p className="asi-page-description">
          Curate a preference shortlist above the unchanged evidence-ranked
          research queue. Picks retain their source provenance and never change
          research scores or verified identity.
        </p>
      </header>
      <InvestorPicksAdmin />
    </>
  );
}
