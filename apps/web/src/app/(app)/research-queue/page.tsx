import { DiscoverResearchAction } from "@/components/discover-research-action";
import { ProposalReviewTable } from "@/components/proposal-review-table";
import { requireUser } from "@/lib/auth";

export default async function ResearchQueuePage() {
  const user = await requireUser();
  const canReview = user.role === "analyst" || user.role === "admin";

  return (
    <>
      <header className="asi-page-header">
        <div>
          <p className="asi-page-kicker">Research operations</p>
          <h1 className="asi-page-title">Proposal review queue</h1>
          <p className="asi-page-description">
            Compare every proposed fact with its source evidence before it can
            change canonical supplier intelligence.
          </p>
        </div>
      </header>

      <DiscoverResearchAction canQueue={canReview} />
      <ProposalReviewTable canReview={canReview} />
    </>
  );
}
