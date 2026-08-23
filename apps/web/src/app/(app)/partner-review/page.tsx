import { redirect } from "next/navigation";

/**
 * Partner Review dissolved into the Targets table (REDESIGN_PLAN §2.3/§5):
 * the old queue lives on as the "Partner queue" saved view — High interest.
 */
export default function PartnerReviewPage(): never {
  redirect("/feed?tier=high_interest");
}
