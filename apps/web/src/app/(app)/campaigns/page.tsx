import { redirect } from "next/navigation";

/**
 * Campaigns folded into the Research control plane (REDESIGN_PLAN §3/§5):
 * the compact campaigns strip on /research lists them; lifecycle actions stay
 * on each campaign's detail page (/campaigns/[id] remains live).
 */
export default function CampaignsPage(): never {
  redirect("/research");
}
