import { redirect } from "next/navigation";

/**
 * Research Queue dissolved into the Targets table (REDESIGN_PLAN §2.3/§5):
 * the old queue lives on as the "Needs research" saved view.
 */
export default function ResearchQueuePage(): never {
  redirect("/feed?tier=needs_research");
}
