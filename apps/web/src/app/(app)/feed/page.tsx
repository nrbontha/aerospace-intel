import { Suspense } from "react";

import { LeadsInbox } from "@/components/lead-pipeline/leads-inbox";
import { TargetFeed } from "@/components/target-feed/target-feed";
import { requireUser } from "@/lib/auth";

export const metadata = {
  title: "Pipeline feed",
  description:
    "Discovery inbox of raw federal leads above the tiered targets table — identities verified here seed candidates there.",
};

export default async function FeedPage() {
  const user = await requireUser();
  const canOperate = user.role === "analyst" || user.role === "admin";

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Pipeline</p>
        <h1 className="asi-page-title">Feed</h1>
        <p className="asi-page-description">
          Two-section working surface. Discovery agents drop raw leads into the
          inbox; once a lead&apos;s domain verifies against its homepage
          identity, a target candidate is seeded automatically into the tiered
          table below. Humans judge; agents work.
        </p>
      </header>

      <Suspense
        fallback={
          <p className="asi-page-description" role="status" aria-live="polite">
            Loading leads…
          </p>
        }
      >
        <LeadsInbox canOperate={canOperate} />
      </Suspense>

      <hr
        aria-hidden="true"
        style={{
          border: 0,
          borderTop: "1px solid var(--asi-border, currentColor)",
          margin: "2rem 0",
        }}
      />

      <section aria-labelledby="targets-heading">
        <header className="asi-page-header">
          <h2 id="targets-heading">Targets</h2>
          <p className="asi-page-description">
            The single tiered table of acquisition-target candidates — fed by
            verified leads above, scored by the engine, overridable by humans
            (audited).
          </p>
        </header>
        <Suspense
          fallback={
            <p className="asi-page-description" role="status" aria-live="polite">
              Loading candidates…
            </p>
          }
        >
          <TargetFeed />
        </Suspense>
      </section>
    </>
  );
}
