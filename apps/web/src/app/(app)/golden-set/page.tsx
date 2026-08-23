import { redirect } from "next/navigation";

/**
 * Golden Set dissolved into the Universe tab (REDESIGN_PLAN §4/§5).
 */
export default function GoldenSetPage(): never {
  redirect("/universe?tab=golden-set");
}
