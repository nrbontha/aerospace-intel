import Link from "next/link";

import { ResearchRunLive } from "@/components/research-run-live";

export default async function ResearchRunDetailPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Research operations</p>
        <h1 className="asi-page-title">Research run detail</h1>
        <p className="asi-page-description">
          <Link href="/research-runs">Research runs</Link>
          {" / "}
          <span style={{ fontFamily: "var(--asi-font-mono)" }}>{id}</span>
        </p>
      </header>

      <ResearchRunLive runId={id} />
    </>
  );
}
