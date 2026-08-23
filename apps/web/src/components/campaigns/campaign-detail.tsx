"use client";

import type { CampaignDto } from "@asi/contracts";
import {
  frontierItemStatusValues,
  frontierItemTypeValues,
  type FrontierItemDto,
  type FrontierItemStatus,
  type FrontierItemType,
} from "@asi/contracts";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  CampaignStatusBadge,
  FrontierStatusChip,
  SpendMeter,
  formatTimestamp,
  frontierBreakdownSummary,
  lifecycleEnabled,
  truncate,
} from "@/components/campaigns/campaign-bits";
import { humanLabel } from "@/components/target-feed/candidate-bits";
import {
  addManualFrontierItem,
  getCampaignDetail,
  isDuplicateFrontierResult,
  type CampaignDetailPayload,
  type LeadRecord,
  listCampaignLeads,
  listFrontierItems,
  postLifecycleAction,
  type LifecycleAction,
  type ManualFrontierResult,
} from "@/lib/campaigns-api";

const LEAD_STATUS_TONES: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  new: "info",
  resolving: "info",
  resolved: "success",
  unresolved_lead: "warning",
  discarded: "neutral",
};

/** Frontier item types shown first in the manual-add select; the rest follow. */
const COMMON_ITEM_TYPES: readonly FrontierItemType[] = [
  "source",
  "query",
  "url",
  "domain",
  "company",
];

export function CampaignDetailView({
  campaignId,
  canOperate,
}: {
  campaignId: string;
  canOperate: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [detail, setDetail] = useState<CampaignDetailPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // URL-persisted frontier filters.
  const frontierStatus = searchParams.get("fstatus") ?? "";
  const frontierType = searchParams.get("ftype") ?? "";
  const frontierPage = Number(searchParams.get("fpage") ?? "1") || 1;

  const [items, setItems] = useState<FrontierItemDto[]>([]);
  const [itemsMeta, setItemsMeta] = useState<{
    totalItems: number;
    totalPages: number;
  }>();
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);

  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [leadsMeta, setLeadsMeta] = useState<{
    totalItems: number;
    totalPages: number;
  }>();
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState<string | null>(null);

  const [transitioning, setTransitioning] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function replaceFilters(changes: Readonly<Record<string, string>>): void {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === "") params.delete(key);
      else params.set(key, value);
    }
    const serialized = params.toString();
    router.replace(
      serialized === "" ? pathname : `${pathname}?${serialized}`,
      { scroll: false },
    );
  }

  const loadDetail = useCallback(
    async (signal: AbortSignal) => {
      setLoadError(null);
      try {
        setDetail(await getCampaignDetail(campaignId, signal));
      } catch (caught) {
        if (!signal.aborted) {
          setLoadError(
            caught instanceof Error
              ? caught.message
              : "Unable to load this campaign.",
          );
        }
      }
    },
    [campaignId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDetail(controller.signal);
    return () => controller.abort();
  }, [loadDetail, reloadKey]);

  const loadItems = useCallback(
    async (signal: AbortSignal) => {
      setItemsLoading(true);
      setItemsError(null);
      try {
        const result = await listFrontierItems(
          campaignId,
          {
            itemType: frontierType as FrontierItemType | "",
            page: frontierPage,
            status: frontierStatus as FrontierItemStatus | "",
          },
          signal,
        );
        setItems(result.data);
        setItemsMeta({
          totalItems: result.meta?.totalItems ?? result.data.length,
          totalPages: result.meta?.totalPages ?? 1,
        });
      } catch (caught) {
        if (!signal.aborted) {
          setItems([]);
          setItemsError(
            caught instanceof Error
              ? caught.message
              : "Unable to load frontier items.",
          );
        }
      } finally {
        if (!signal.aborted) setItemsLoading(false);
      }
    },
    [campaignId, frontierPage, frontierStatus, frontierType],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadItems(controller.signal);
    return () => controller.abort();
  }, [loadItems, reloadKey]);

  const loadLeads = useCallback(
    async (signal: AbortSignal) => {
      setLeadsLoading(true);
      setLeadsError(null);
      try {
        const result = await listCampaignLeads(campaignId, leadsPage, signal);
        setLeads(result.data);
        setLeadsMeta({
          totalItems: result.meta?.totalItems ?? result.data.length,
          totalPages: result.meta?.totalPages ?? 1,
        });
      } catch (caught) {
        if (!signal.aborted) {
          setLeads([]);
          setLeadsError(
            caught instanceof Error ? caught.message : "Unable to load leads.",
          );
        }
      } finally {
        if (!signal.aborted) setLeadsLoading(false);
      }
    },
    [campaignId, leadsPage],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadLeads(controller.signal);
    return () => controller.abort();
  }, [loadLeads, reloadKey]);

  async function runLifecycle(action: LifecycleAction): Promise<void> {
    if (
      !window.confirm(
        `Are you sure you want to ${action} this campaign? The transition is audited.`,
      )
    ) {
      return;
    }
    setTransitioning(true);
    setLifecycleError(null);
    try {
      await postLifecycleAction(campaignId, action);
      setReloadKey((key) => key + 1);
    } catch (caught) {
      setLifecycleError(
        caught instanceof Error
          ? caught.message
          : `The ${action} request failed.`,
      );
    } finally {
      setTransitioning(false);
    }
  }

  async function copyValue(item: FrontierItemDto): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.normalizedValue);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard unavailable (permissions / non-secure context); no-op.
    }
  }

  if (loadError !== null) {
    return (
      <div className="admin-panel" role="alert">
        <p className="admin-feedback" data-tone="error">
          {loadError}
        </p>
        <div className="admin-actions">
          <Button onClick={() => setReloadKey((key) => key + 1)} variant="secondary">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="admin-panel" role="status">
        Loading campaign…
      </div>
    );
  }

  const campaign: CampaignDto = detail.campaign;
  const breakdown = detail.frontierBreakdown;
  const totalFrontierItems = Object.values(breakdown).reduce(
    (sum, value) => sum + value,
    0,
  );

  return (
    <>
      <header className="admin-panel">
        <div className="admin-panel__header">
          <h2>{campaign.name}</h2>
          <p className="asi-page-description">
            {campaign.objective === null
              ? "No objective recorded."
              : campaign.objective}
          </p>
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--asi-space-8)",
          }}
        >
          <CampaignStatusBadge status={campaign.status} />
          <span className="asi-page-description">
            thesis {campaign.thesisVersion} · policy {campaign.policyVersion} ·
            concurrency {campaign.concurrency} · max depth {campaign.maxDepth}
          </span>
          <SpendMeter budgetUsd={campaign.budgetUsd} spendUsd={campaign.spendUsd} />
          <Link href="/campaigns">← All campaigns</Link>
        </div>
        <p className="asi-page-description">
          Policy {detail.policy.version}: sources{" "}
          {detail.policy.enabledSources.join(", ") || "none"} · max depth{" "}
          {detail.policy.maxDepth}
        </p>
        {canOperate ? (
          <div className="admin-actions">
            {(["start", "pause", "resume", "cancel"] as const).map((action) => {
              const needsSeed = action === "start" && totalFrontierItems === 0;
              const enabled =
                lifecycleEnabled(campaign.status, action) && !needsSeed;
              return (
                <Button
                  disabled={transitioning || !enabled}
                  key={action}
                  onClick={() => void runLifecycle(action)}
                  size="small"
                  title={
                    needsSeed
                      ? "Add at least one frontier item before starting"
                      : lifecycleEnabled(campaign.status, action)
                        ? undefined
                        : `${humanLabel(action)} is not available from ${humanLabel(campaign.status)}`
                  }
                  variant={action === "cancel" ? "danger" : "secondary"}
                >
                  {humanLabel(action)}
                </Button>
              );
            })}
          </div>
        ) : null}
        {lifecycleError !== null ? (
          <p className="admin-feedback" data-tone="error" role="alert">
            {lifecycleError}
          </p>
        ) : null}
      </header>

      {/* --------------------------------------------------------------- */}
      {/* Frontier */}
      {/* --------------------------------------------------------------- */}
      <section aria-labelledby="frontier-heading" className="admin-panel">
        <header className="admin-panel__header">
          <h2 id="frontier-heading">Discovery frontier</h2>
          <p className="asi-page-description">
            {frontierBreakdownSummary(breakdown)} · {totalFrontierItems} total
          </p>
        </header>

        {canOperate ? (
          <ManualItemForm
            campaignId={campaignId}
            onAdded={(result) => {
              if (!isDuplicateFrontierResult(result)) {
                setReloadKey((key) => key + 1);
              }
            }}
          />
        ) : null}

        <form
          className="admin-form-grid"
          role="search"
          onSubmit={(event) => event.preventDefault()}
        >
          <label className="admin-field" htmlFor="frontier-status">
            <span className="admin-field__label">Item status</span>
            <Select
              id="frontier-status"
              onChange={(event) =>
                replaceFilters({ fstatus: event.target.value, fpage: "" })
              }
              value={frontierStatus}
            >
              <option value="">All statuses</option>
              {frontierItemStatusValues.map((value) => (
                <option key={value} value={value}>
                  {humanLabel(value)}
                </option>
              ))}
            </Select>
          </label>
          <label className="admin-field" htmlFor="frontier-type">
            <span className="admin-field__label">Item type</span>
            <Select
              id="frontier-type"
              onChange={(event) =>
                replaceFilters({ ftype: event.target.value, fpage: "" })
              }
              value={frontierType}
            >
              <option value="">All types</option>
              {frontierItemTypeValues.map((value) => (
                <option key={value} value={value}>
                  {humanLabel(value)}
                </option>
              ))}
            </Select>
          </label>
        </form>

        {itemsError !== null ? (
          <p className="admin-feedback" data-tone="error" role="alert">
            {itemsError}
          </p>
        ) : itemsLoading && items.length === 0 ? (
          <p className="asi-page-description" role="status">
            Loading frontier…
          </p>
        ) : items.length === 0 ? (
          <EmptyState
            title={
              frontierStatus !== "" || frontierType !== ""
                ? "No frontier items match these filters"
                : "The frontier is empty"
            }
          >
            {frontierStatus === "" && frontierType === ""
              ? "Nothing has been discovered or added yet. Add a seed item manually above."
              : null}
          </EmptyState>
        ) : (
          <Table>
            <TableCaption>
              {items.length} item{items.length === 1 ? "" : "s"} on this page
              {itemsMeta ? ` · ${itemsMeta.totalItems} total` : ""}.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Attempts</TableHead>
                <TableHead numeric>Depth</TableHead>
                <TableHead>Failure</TableHead>
                <TableHead>Discovered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{humanLabel(item.itemType)}</TableCell>
                  <TableCell>
                    <span
                      style={{
                        alignItems: "center",
                        display: "inline-flex",
                        gap: "var(--asi-space-4)",
                      }}
                    >
                      <span title={item.normalizedValue}>
                        {truncate(item.normalizedValue, 48)}
                      </span>
                      <Button
                        aria-label={`Copy value ${item.normalizedValue}`}
                        onClick={() => void copyValue(item)}
                        size="small"
                        variant="ghost"
                      >
                        {copiedId === item.id ? "Copied" : "Copy"}
                      </Button>
                    </span>
                  </TableCell>
                  <TableCell>
                    <FrontierStatusChip status={item.status} />
                  </TableCell>
                  <TableCell numeric>{item.attemptCount}</TableCell>
                  <TableCell numeric>{item.depth}</TableCell>
                  <TableCell>
                    {item.failureReason === null ? (
                      "—"
                    ) : (
                      <span
                        className="asi-page-description"
                        style={{ cursor: "help" }}
                        title={item.failureReason}
                      >
                        ⚠ reason
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{formatTimestamp(item.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {itemsMeta !== undefined && itemsMeta.totalPages > 1 ? (
          <nav aria-label="Frontier pages" className="admin-actions">
            <Button
              disabled={frontierPage <= 1}
              onClick={() =>
                replaceFilters({ fpage: String(frontierPage - 1) })
              }
              size="small"
              variant="secondary"
            >
              Previous
            </Button>
            <span className="asi-page-description">
              Page {frontierPage} of {itemsMeta.totalPages}
            </span>
            <Button
              disabled={frontierPage >= itemsMeta.totalPages}
              onClick={() =>
                replaceFilters({ fpage: String(frontierPage + 1) })
              }
              size="small"
              variant="secondary"
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Leads */}
      {/* --------------------------------------------------------------- */}
      <section aria-labelledby="leads-heading" className="admin-panel">
        <header className="admin-panel__header">
          <h2 id="leads-heading">Leads from this campaign</h2>
          <p className="asi-page-description">
            Raw lead records with their identity-match tallies.
          </p>
        </header>
        {leadsError !== null ? (
          <p className="admin-feedback" data-tone="error" role="alert">
            {leadsError}
          </p>
        ) : leadsLoading && leads.length === 0 ? (
          <p className="asi-page-description" role="status">
            Loading leads…
          </p>
        ) : leads.length === 0 ? (
          <EmptyState title="No leads recorded for this campaign yet" />
        ) : (
          <Table>
            <TableCaption>
              {leads.length} lead{leads.length === 1 ? "" : "s"} on this page
              {leadsMeta ? ` · ${leadsMeta.totalItems} total` : ""}.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Raw name</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Matches (pending / merged / rejected)</TableHead>
                <TableHead>Resolved company</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell>
                    <strong>{lead.rawName}</strong>
                  </TableCell>
                  <TableCell>{lead.possibleDomain ?? "—"}</TableCell>
                  <TableCell>
                    <Badge tone={LEAD_STATUS_TONES[lead.status] ?? "neutral"}>
                      {humanLabel(lead.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {lead.matchSummary.pending} / {lead.matchSummary.merged} /{" "}
                    {lead.matchSummary.rejected}
                  </TableCell>
                  <TableCell>
                    {lead.resolvedCompanyId === null ? (
                      "—"
                    ) : (
                      <Link href={`/companies/${lead.resolvedCompanyId}`}>
                        View company
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>{formatTimestamp(lead.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {leadsMeta !== undefined && leadsMeta.totalPages > 1 ? (
          <nav aria-label="Lead pages" className="admin-actions">
            <Button
              disabled={leadsPage <= 1}
              onClick={() => setLeadsPage((page) => page - 1)}
              size="small"
              variant="secondary"
            >
              Previous
            </Button>
            <span className="asi-page-description">
              Page {leadsPage} of {leadsMeta.totalPages}
            </span>
            <Button
              disabled={leadsPage >= leadsMeta.totalPages}
              onClick={() => setLeadsPage((page) => page + 1)}
              size="small"
              variant="secondary"
            >
              Next
            </Button>
          </nav>
        ) : null}
      </section>
    </>
  );
}


// ---------------------------------------------------------------------------
// Manual frontier add form
// ---------------------------------------------------------------------------

const PAYLOAD_EXAMPLE = "{}";

function ManualItemForm({
  campaignId,
  onAdded,
}: {
  campaignId: string;
  onAdded: (result: ManualFrontierResult) => void;
}) {
  const [itemType, setItemType] = useState<FrontierItemType>("query");
  const [value, setValue] = useState("");
  const [payloadText, setPayloadText] = useState(PAYLOAD_EXAMPLE);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<
    Readonly<{ tone: "success" | "error"; message: string }> | null
  >(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === "") {
      setFeedback({ tone: "error", message: "A value is required." });
      return;
    }
    let payload: Record<string, unknown> | undefined;
    if (payloadText.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(payloadText);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setFeedback({
            tone: "error",
            message: "Payload must be a JSON object.",
          });
          return;
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        setFeedback({ tone: "error", message: "Payload is not valid JSON." });
        return;
      }
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await addManualFrontierItem(campaignId, {
        itemType,
        normalizedValue: trimmed,
        ...(payload === undefined ? {} : { payload }),
      });
      if (isDuplicateFrontierResult(result)) {
        setFeedback({
          tone: "error",
          message: "That item already exists on the frontier (duplicate).",
        });
      } else {
        setValue("");
        setPayloadText(PAYLOAD_EXAMPLE);
        setFeedback({ tone: "success", message: "Frontier item added." });
      }
      onAdded(result);
    } catch (caught) {
      setFeedback({
        tone: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "Adding the frontier item failed.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const typeOptions = [
    ...COMMON_ITEM_TYPES,
    ...frontierItemTypeValues.filter((value) => !COMMON_ITEM_TYPES.includes(value)),
  ];

  return (
    <form onSubmit={(event) => void submit(event)}>
      <div className="admin-form-grid">
        <label className="admin-field" htmlFor="manual-item-type">
          <span className="admin-field__label">Item type</span>
          <Select
            id="manual-item-type"
            onChange={(event) =>
              setItemType(event.target.value as FrontierItemType)
            }
            value={itemType}
          >
            {typeOptions.map((value) => (
              <option key={value} value={value}>
                {humanLabel(value)}
              </option>
            ))}
          </Select>
        </label>
        <label className="admin-field" htmlFor="manual-item-value">
          <span className="admin-field__label">Normalized value</span>
          <Input
            id="manual-item-value"
            maxLength={2_000}
            onChange={(event) => setValue(event.target.value)}
            placeholder="e.g. usaspending or a domain"
            value={value}
          />
        </label>
      </div>
      <div className="admin-field">
        <label className="admin-field__label" htmlFor="manual-item-payload">
          Payload (optional JSON)
        </label>
        <textarea
          id="manual-item-payload"
          onChange={(event) => setPayloadText(event.target.value)}
          rows={3}
          spellCheck={false}
          style={{ fontFamily: "monospace", inlineSize: "100%" }}
          value={payloadText}
        />
      </div>
      {feedback !== null ? (
        <p
          className="admin-feedback"
          data-tone={feedback.tone}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}
      <div className="admin-actions">
        <Button disabled={submitting} type="submit">
          {submitting ? "Adding…" : "Add frontier item"}
        </Button>
      </div>
    </form>
  );
}
