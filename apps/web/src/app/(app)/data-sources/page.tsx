import { redirect } from "next/navigation";

/**
 * Data sources dissolved into the Universe tab (REDESIGN_PLAN §4/§5).
 * Detail routes (/data-sources/[id], /data-sources/new) stay live.
 */
export default function DataSourcesPage(): never {
  redirect("/universe?tab=sources");
}
