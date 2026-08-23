import { redirect } from "next/navigation";

/**
 * Dashboard dissolved into the Targets table (REDESIGN_PLAN §2/§5): the tiered
 * feed is the continuously-updated operational surface.
 */
export default function DashboardPage(): never {
  redirect("/feed");
}
