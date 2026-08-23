import { redirect } from "next/navigation";

/**
 * Research runs dissolved into the Research control plane (REDESIGN_PLAN §3/§5):
 * tick journals on /research carry per-run progress, cost, and outcomes.
 */
export default function ResearchRunsPage(): never {
  redirect("/research");
}
