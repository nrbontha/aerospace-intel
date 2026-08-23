import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CatalogExport } from "@/components/catalog-export";
import { CompanyExplorer } from "@/components/company-explorer";
import { DataSourceExplorer } from "@/components/data-source-explorer";
import { GoldenSetExplorer } from "@/components/golden-set-explorer";
import { KnownUniverseSnapshots } from "@/components/known-universe-snapshots";
import { requireUser } from "@/lib/auth";

import { IdentityMatchQueue } from "./identity-match-queue";
import { MergeHistory } from "./merge-history";

export const metadata: Metadata = { title: "Universe | ASI" };

const tabs = [
  {
    key: "companies",
    label: "Companies",
    description:
      "Find supplier entities created by research, browse imported universe snapshots, and test any name against the canonical catalog.",
  },
  {
    key: "identity-review",
    label: "Identity review",
    description:
      "Decide probable identity matches between leads and known companies, then audit applied merges.",
  },
  {
    key: "golden-set",
    label: "Golden Set",
    description:
      "Review the workbook examples that define supplier classification labels — the calibration ground truth.",
  },
  {
    key: "sources",
    label: "Sources",
    description:
      "Register where evidence originates, how it may be accessed, and how it can be ingested.",
  },
] as const;

type UniverseTabKey = (typeof tabs)[number]["key"];

const tabKeys = new Set<string>(tabs.map((tab) => tab.key));

function activeTabKey(raw: string | undefined): UniverseTabKey {
  return raw !== undefined && tabKeys.has(raw)
    ? (raw as UniverseTabKey)
    : "companies";
}

function activeTab(key: UniverseTabKey) {
  return tabs.find((tab) => tab.key === key) ?? tabs[0];
}

export default async function UniversePage(props: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const searchParams = await props.searchParams;
  const current = activeTabKey(searchParams.tab);
  const user = await requireUser();
  const canReview = user.role === "analyst" || user.role === "admin";

  return (
    <>
      <header className="asi-page-header">
        <p className="asi-page-kicker">Universe</p>
        <h1 className="asi-page-title">{activeTab(current).label}</h1>
        <p className="asi-page-description">
          {activeTab(current).description}
        </p>
      </header>

      <div aria-label="Universe sections" className="asi-tabs" role="tablist">
        {tabs.map((tab) => (
          <Link
            aria-selected={tab.key === current}
            className="asi-tab"
            href={`/universe?tab=${tab.key}`}
            key={tab.key}
            role="tab"
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {current === "companies" ? (
        <>
          <CatalogExport entity="companies" />
          <Suspense
            fallback={
              <div className="admin-panel" role="status">
                Loading companies…
              </div>
            }
          >
            <CompanyExplorer />
          </Suspense>
          <Suspense
            fallback={
              <div className="admin-panel" role="status">
                Loading snapshots…
              </div>
            }
          >
            <KnownUniverseSnapshots />
          </Suspense>
        </>
      ) : null}

      {current === "identity-review" ? (
        <>
          <Suspense
            fallback={
              <div className="admin-panel" role="status">
                Loading match queue…
              </div>
            }
          >
            <IdentityMatchQueue canDecide={canReview} />
          </Suspense>
          <MergeHistory />
        </>
      ) : null}

      {current === "golden-set" ? (
        <Suspense
          fallback={
            <div className="admin-panel" role="status">
              Loading golden set…
            </div>
          }
        >
          <GoldenSetExplorer canReview={canReview} />
        </Suspense>
      ) : null}

      {current === "sources" ? (
        <>
          <div className="admin-actions">
            <CatalogExport entity="data_sources" />
            <Link
              className="asi-button"
              data-size="medium"
              data-variant="primary"
              href="/data-sources/new"
            >
              Add source
            </Link>
          </div>
          <Suspense
            fallback={
              <div className="admin-panel" role="status">
                Loading source filters…
              </div>
            }
          >
            <DataSourceExplorer />
          </Suspense>
        </>
      ) : null}
    </>
  );
}
