import { Suspense } from "react";

import { ResearchControlPlane } from "@/components/research-control/research-control-plane";
import { requireUser } from "@/lib/auth";

export const metadata = {
  title: "Research",
  description:
    "Agent control plane: live strip, agents table, tick journals and campaigns.",
};

export default async function ResearchPage() {
  const user = await requireUser();

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Control plane</p>
        <h1 className="asi-page-title">Research</h1>
        <p className="asi-page-description">
          Autonomous research agents at work: what is running, what it costs,
          what it has found — with human pause, resume and kill controls. Humans
          judge; agents work.
        </p>
      </header>
      <Suspense
        fallback={
          <p className="asi-page-description" role="status" aria-live="polite">
            Loading agent control plane…
          </p>
        }
      >
        <ResearchControlPlane role={user.role} />
      </Suspense>
    </>
  );
}
