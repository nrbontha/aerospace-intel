import { redirect } from "next/navigation";

/**
 * Merges dissolved into the Universe identity-review tab (REDESIGN_PLAN §4/§5).
 */
export default function MergesPage(): never {
  redirect("/universe?tab=identity-review");
}
