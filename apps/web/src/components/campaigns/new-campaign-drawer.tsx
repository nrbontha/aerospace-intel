"use client";

import type { CampaignDto } from "@asi/contracts";
import { campaignSeedsSchema } from "@asi/contracts";
import { Button, Input, Select } from "@asi/ui";
import { useState } from "react";

import Link from "next/link";

import { createCampaign } from "@/lib/campaigns-api";

/** Matches the real campaignSeedsSchema shape (geography is a string array). */
const SEEDS_EXAMPLE = JSON.stringify(
  { sources: ["usaspending"], platforms: [], capabilities: [], geography: [] },
  null,
  2,
);

type SeedsValidation =
  | Readonly<{ ok: true; value: Record<string, unknown> }>
  | Readonly<{ ok: false; message: string }>;

function validateSeeds(text: string): SeedsValidation {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `Invalid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    };
  }
  const parsed = campaignSeedsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "seeds"}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      message: `Seeds do not match the schema. Expected keys: sources, platforms, capabilities, geography (arrays of strings). ${issues}`,
    };
  }
  return { ok: true, value: parsed.data };
}

export function NewCampaignDrawer(props: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { open, onClose, onCreated } = props;
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [seedsText, setSeedsText] = useState(SEEDS_EXAMPLE);
  const [budgetUsd, setBudgetUsd] = useState("");
  const [concurrency, setConcurrency] = useState("4");
  const [maxDepth, setMaxDepth] = useState("2");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CampaignDto | null>(null);

  function reset(): void {
    setName("");
    setObjective("");
    setSeedsText(SEEDS_EXAMPLE);
    setBudgetUsd("");
    setConcurrency("4");
    setMaxDepth("2");
    setFormError(null);
    setCreated(null);
  }

  function close(): void {
    reset();
    onClose();
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setFormError("A campaign name is required.");
      return;
    }
    const seeds = validateSeeds(seedsText);
    if (!seeds.ok) {
      setFormError(seeds.message);
      return;
    }
    const budget = budgetUsd.trim() === "" ? undefined : Number(budgetUsd);
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
      setFormError("Budget must be a non-negative number.");
      return;
    }
    const concurrencyValue = concurrency.trim() === "" ? undefined : Number(concurrency);
    if (
      concurrencyValue !== undefined &&
      (!Number.isInteger(concurrencyValue) ||
        concurrencyValue < 1 ||
        concurrencyValue > 16)
    ) {
      setFormError("Concurrency must be an integer between 1 and 16.");
      return;
    }
    const depthValue = maxDepth.trim() === "" ? undefined : Number(maxDepth);
    if (
      depthValue !== undefined &&
      (!Number.isInteger(depthValue) || depthValue < 0 || depthValue > 16)
    ) {
      setFormError("Max depth must be an integer between 0 and 16.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const campaign = await createCampaign({
        name: trimmedName,
        ...(objective.trim() === "" ? {} : { objective: objective.trim() }),
        ...(Object.keys(seeds.value).length === 0 ? {} : { seeds: seeds.value }),
        ...(budget === undefined ? {} : { budgetUsd: budget }),
        ...(concurrencyValue === undefined ? {} : { concurrency: concurrencyValue }),
        ...(depthValue === undefined ? {} : { maxDepth: depthValue }),
      });
      setCreated(campaign);
      onCreated();
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Campaign creation failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }


  if (!open) return null;

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="presentation"
      style={{
        alignItems: "flex-start",
        background: "color-mix(in srgb, black 45%, transparent)",
        display: "flex",
        inset: 0,
        justifyContent: "flex-end",
        overflowY: "auto",
        padding: "var(--asi-space-12)",
        position: "fixed",
        zIndex: 60,
      }}
    >
      <aside
        aria-label="New research campaign"
        className="admin-panel"
        role="dialog"
        style={{ background: "var(--asi-bg)", inlineSize: "100%", maxInlineSize: "44rem" }}
      >
        <header className="admin-panel__header">
          <h2>New research campaign</h2>
          <Button size="small" variant="ghost" onClick={close}>
            Close
          </Button>
        </header>

        {created !== null ? (
          <div>
            <p className="admin-feedback" data-tone="success" role="status">
              Campaign “{created.name}” created as a draft.
            </p>
            <p className="asi-page-description">
              A fresh campaign has an empty frontier. Add at least one frontier
              item on the detail page before starting.
            </p>
            <div className="admin-actions">
              <Link href={`/campaigns/${created.id}`}>
                <Button variant="primary">Open campaign</Button>
              </Link>
              <Button disabled variant="secondary" title="Add a frontier item first">
                Start now
              </Button>
              <Button variant="ghost" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <div className="admin-form-grid">
              <label className="admin-field" htmlFor="campaign-name">
                <span className="admin-field__label">Name</span>
                <Input
                  id="campaign-name"
                  maxLength={300}
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
              </label>
              <label className="admin-field" htmlFor="campaign-objective">
                <span className="admin-field__label">Objective</span>
                <Input
                  id="campaign-objective"
                  maxLength={10_000}
                  onChange={(event) => setObjective(event.target.value)}
                  placeholder="What question should this campaign answer?"
                  value={objective}
                />
              </label>
              <label className="admin-field" htmlFor="campaign-budget">
                <span className="admin-field__label">Budget (USD)</span>
                <Input
                  id="campaign-budget"
                  inputMode="decimal"
                  min={0}
                  onChange={(event) => setBudgetUsd(event.target.value)}
                  placeholder="e.g. 250"
                  type="number"
                  value={budgetUsd}
                />
              </label>
              <label className="admin-field" htmlFor="campaign-concurrency">
                <span className="admin-field__label">Concurrency</span>
                <Select
                  id="campaign-concurrency"
                  onChange={(event) => setConcurrency(event.target.value)}
                  value={concurrency}
                >
                  {[1, 2, 4, 8, 12, 16].map((value) => (
                    <option key={value} value={String(value)}>
                      {value}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="admin-field" htmlFor="campaign-max-depth">
                <span className="admin-field__label">Max depth</span>
                <Select
                  id="campaign-max-depth"
                  onChange={(event) => setMaxDepth(event.target.value)}
                  value={maxDepth}
                >
                  {Array.from({ length: 17 }, (_, value) => (
                    <option key={value} value={String(value)}>
                      {value}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <div className="admin-field">
              <label className="admin-field__label" htmlFor="campaign-seeds">
                Seeds (JSON)
              </label>
              <textarea
                className="asi-code-input"
                id="campaign-seeds"
                onChange={(event) => setSeedsText(event.target.value)}
                rows={8}
                spellCheck={false}
                style={{ inlineSize: "100%", fontFamily: "monospace" }}
                value={seedsText}
              />
              <p className="asi-page-description">
                Validated against the campaign seeds schema: arrays named
                sources, platforms, capabilities, geography.
              </p>
            </div>

            {formError !== null ? (
              <p className="admin-feedback" data-tone="error" role="alert">
                {formError}
              </p>
            ) : null}

            <div className="admin-actions">
              <Button disabled={submitting} type="submit">
                {submitting ? "Creating…" : "Create draft"}
              </Button>
              <Button disabled={submitting} type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
