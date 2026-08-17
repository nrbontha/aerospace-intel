"use client";

import { Button, Input } from "@asi/ui";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { apiJson } from "@/components/csrf-client";

type QueuedRun = Readonly<{ id: string; status: string }>;

const TARGETS = ["company", "facility", "platform", "part", "data_source"] as const;

export function DiscoverResearchAction({
  canQueue,
}: Readonly<{ canQueue: boolean }>) {
  const [objective, setObjective] = useState("");
  const [seedTerms, setSeedTerms] = useState("");
  const [targets, setTargets] = useState<string[]>(["company"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [run, setRun] = useState<QueuedRun>();

  function toggle(target: string): void {
    setTargets((current) =>
      current.includes(target)
        ? current.filter((item) => item !== target)
        : [...current, target],
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canQueue) return;
    setBusy(true);
    setError(undefined);
    try {
      const terms = seedTerms
        .split(",")
        .map((term) => term.trim())
        .filter((term) => term !== "");
      const queued = await apiJson<QueuedRun>("/api/v1/research-runs", {
        method: "POST",
        body: JSON.stringify({
          kind: "discover",
          objective,
          targetTypes: targets,
          ...(terms.length === 0 ? {} : { seedTerms: terms }),
          metadata: { initiatedFrom: "research_queue" },
        }),
      });
      setRun(queued);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to queue discovery");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel" aria-labelledby="discover-heading">
      <header className="admin-panel__header">
        <h2 id="discover-heading">Discovery research</h2>
        <p className="asi-page-description">
          Search local reviewed evidence first, then at most a few public seed
          URLs. Discovery creates proposals, never canonical facts.
        </p>
      </header>
      {canQueue ? (
        <form className="admin-stack" onSubmit={(event) => void onSubmit(event)}>
          <label className="admin-field" htmlFor="discover-objective">
            <span className="admin-field__label">Objective</span>
            <Input
              id="discover-objective"
              required
              maxLength={2000}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Find investment-casting suppliers for a named platform"
            />
          </label>
          <label className="admin-field" htmlFor="discover-seeds">
            <span className="admin-field__label">Seed terms (comma-separated)</span>
            <Input
              id="discover-seeds"
              value={seedTerms}
              onChange={(event) => setSeedTerms(event.target.value)}
              placeholder="Hitchiner, countergravity, F-35"
            />
          </label>
          <fieldset className="admin-field">
            <legend className="admin-field__label">Target types</legend>
            {TARGETS.map((target) => (
              <label key={target} className="admin-inline-control">
                <input
                  type="checkbox"
                  checked={targets.includes(target)}
                  onChange={() => toggle(target)}
                />
                {target.replaceAll("_", " ")}
              </label>
            ))}
          </fieldset>
          <div className="admin-actions">
            <Button type="submit" isLoading={busy} disabled={targets.length === 0}>
              Queue discovery
            </Button>
            {run ? <Link href={`/research-runs/${run.id}`}>View queued run</Link> : null}
          </div>
        </form>
      ) : (
        <p className="asi-page-description">
          An analyst or administrator can queue discovery research.
        </p>
      )}
      {error ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
