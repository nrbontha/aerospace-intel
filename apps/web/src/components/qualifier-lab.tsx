"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";

import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@asi/ui";

import { apiJson } from "@/components/csrf-client";
import {
  runResultEntries,
  type ExperimentRunView,
  type RunResultEntry,
  type ScoringProgramView,
} from "@/components/experiments-types";

const stackStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-4)",
};
const cardsStyle: CSSProperties = {
  display: "grid",
  gap: "var(--asi-space-4)",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
};
const cardStyle: CSSProperties = {
  border: "1px solid var(--asi-border)",
  borderRadius: "var(--asi-radius-md, 8px)",
  display: "grid",
  gap: "var(--asi-space-3)",
  padding: "var(--asi-space-4)",
};
const mutedStyle: CSSProperties = {
  color: "var(--asi-text-muted)",
  fontSize: "var(--asi-text-xs)",
};
const monoStyle: CSSProperties = {
  background: "var(--asi-surface-muted)",
  borderRadius: "var(--asi-radius-sm, 6px)",
  fontFamily: "var(--asi-font-mono)",
  fontSize: "var(--asi-text-xs)",
  margin: 0,
  maxHeight: "18rem",
  overflow: "auto",
  padding: "var(--asi-space-3)",
};
const sectionTitleStyle: CSSProperties = {
  fontSize: "var(--asi-text-lg)",
  fontWeight: 600,
  marginBlockEnd: 0,
};

function formatNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(4)
    : "—";
}

function entriesFromProgram(program: ScoringProgramView): {
  name: string;
  program: Record<string, unknown>;
} {
  return { name: program.name, program: program.program };
}

export function QualifierLab() {
  const [programs, setPrograms] = useState<ScoringProgramView[]>([]);
  const [journal, setJournal] = useState<ExperimentRunView[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [runLabel, setRunLabel] = useState("");
  const [latestRun, setLatestRun] = useState<ExperimentRunView | null>(null);
  const [rationale, setRationale] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerAxis, setRegisterAxis] = useState<"fit" | "actionability">("fit");
  const [registerJson, setRegisterJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [programData, journalData] = await Promise.all([
        apiJson<{ records: ScoringProgramView[] }>("/api/v1/scoring-programs"),
        apiJson<{ records: ExperimentRunView[] }>("/api/v1/experiments?limit=50"),
      ]);
      setPrograms(programData.records);
      setJournal(journalData.records);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const champions = programs.filter((program) => program.isChampion);
  const challengers = programs.filter((program) => !program.isChampion);

  const toggleSelected = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const runEvaluation = async (): Promise<void> => {
    setError(null);
    const selected = programs.filter((program) => selectedIds.has(program.id));
    if (selected.length === 0) {
      setError("Select at least one challenger to evaluate.");
      return;
    }
    setBusy(true);
    try {
      const run = await apiJson<ExperimentRunView>(
        "/api/v1/experiments/run-scorer",
        {
          body: JSON.stringify({
            label:
              runLabel.trim() !== ""
                ? runLabel.trim()
                : `Qualifier evaluation ${new Date().toISOString()}`,
            programs: selected.map(entriesFromProgram),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      setLatestRun(run);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (keep: boolean): Promise<void> => {
    if (latestRun === null) return;
    if (rationale.trim().length < 3) {
      setError("A rationale (min 3 characters) is required for a decision.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/api/v1/experiments/${latestRun.id}/decision`, {
        body: JSON.stringify({ keep, rationale: rationale.trim() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setRationale("");
      setLatestRun(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const registerChallenger = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    setError(null);
    let parsedProgram: unknown;
    try {
      parsedProgram = JSON.parse(registerJson);
    } catch {
      setError("Program JSON is not valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await apiJson("/api/v1/scoring-programs", {
        body: JSON.stringify({
          name: registerName.trim(),
          version: 1,
          axis: registerAxis,
          program: parsedProgram,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      setRegisterName("");
      setRegisterJson("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const results: RunResultEntry[] =
    latestRun === null ? [] : runResultEntries(latestRun);

  return (
    <div style={stackStyle}>
      {error !== null ? (
        <p role="alert" style={{ color: "var(--asi-danger, #b00)" }}>
          {error}
        </p>
      ) : null}

      <section aria-labelledby="qualifier-champions">
        <h2 id="qualifier-champions" style={sectionTitleStyle}>
          Champions
        </h2>
        {champions.length === 0 ? (
          <EmptyState title="No champion yet">
            <p style={mutedStyle}>
              Register and promote a program, or evaluate the shipped defaults.
            </p>
          </EmptyState>
        ) : (
          <div style={cardsStyle}>
            {champions.map((champion) => (
              <article key={champion.id} style={cardStyle}>
                <header
                  style={{
                    alignItems: "center",
                    display: "flex",
                    gap: "var(--asi-space-2)",
                  }}
                >
                  <strong>{champion.name}</strong>
                  <Badge>v{champion.version}</Badge>
                  <Badge>{champion.axis}</Badge>
                </header>
                <p style={mutedStyle}>
                  complexity {formatNumber(champion.complexity)} · registered{" "}
                  {new Date(champion.createdAt).toLocaleString()}
                </p>
                <pre style={monoStyle}>
                  {JSON.stringify(champion.program, null, 2)}
                </pre>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="qualifier-challengers">
        <h2 id="qualifier-challengers" style={sectionTitleStyle}>
          Challengers
        </h2>
        {challengers.length === 0 ? (
          <EmptyState title="No challengers registered">
            <p style={mutedStyle}>Register one below to get started.</p>
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Evaluate</TableHead>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Version</TableHead>
                <TableHead scope="col">Axis</TableHead>
                <TableHead scope="col">Complexity</TableHead>
                <TableHead scope="col">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {challengers.map((challenger) => (
                <TableRow key={challenger.id}>
                  <TableCell>
                    <input
                      aria-label={`Evaluate ${challenger.name}`}
                      checked={selectedIds.has(challenger.id)}
                      onChange={() => toggleSelected(challenger.id)}
                      type="checkbox"
                    />
                  </TableCell>
                  <TableCell>{challenger.name}</TableCell>
                  <TableCell>v{challenger.version}</TableCell>
                  <TableCell>{challenger.axis}</TableCell>
                  <TableCell>{formatNumber(challenger.complexity)}</TableCell>
                  <TableCell>
                    <Badge>{challenger.status}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div
          style={{
            alignItems: "end",
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--asi-space-3)",
            marginBlockStart: "var(--asi-space-4)",
          }}
        >
          <div>
            <label htmlFor="run-label" style={mutedStyle}>
              Run label
            </label>
            <Input
              id="run-label"
              onChange={(event) => setRunLabel(event.target.value)}
              placeholder="e.g. revenue-band challenger"
              value={runLabel}
            />
          </div>
          <Button disabled={busy} onClick={() => void runEvaluation()}>
            {busy ? "Running…" : "Run evaluation"}
          </Button>
        </div>
      </section>

      {latestRun !== null ? (
        <section aria-labelledby="qualifier-results">
          <h2 id="qualifier-results" style={sectionTitleStyle}>
            Latest run results
          </h2>
          <p style={mutedStyle}>{latestRun.label}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Rank</TableHead>
                <TableHead scope="col">Program</TableHead>
                <TableHead scope="col">Role</TableHead>
                <TableHead scope="col">Separation</TableHead>
                <TableHead scope="col">Bootstrap 95% CI</TableHead>
                <TableHead scope="col">LOOCV max move</TableHead>
                <TableHead scope="col">Holdout sep.</TableHead>
                <TableHead scope="col">Complexity</TableHead>
                <TableHead scope="col">Veto audit</TableHead>
                <TableHead scope="col">Leakage scan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...results]
                .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
                .map((entry) => (
                  <TableRow key={`${entry.role}-${entry.name}`}>
                    <TableCell>{entry.rank ?? "—"}</TableCell>
                    <TableCell>{entry.name}</TableCell>
                    <TableCell>{entry.role}</TableCell>
                    <TableCell>
                      {formatNumber(entry.strongVsNegativeSeparation)}
                    </TableCell>
                    <TableCell>
                      {entry.bootstrap === null
                        ? "—"
                        : `${formatNumber(entry.bootstrap.lower)} – ${formatNumber(entry.bootstrap.upper)}`}
                    </TableCell>
                    <TableCell>
                      {entry.loocv === null
                        ? "—"
                        : String(entry.loocv.maxRankMove)}
                    </TableCell>
                    <TableCell>
                      {formatNumber(entry.holdoutSeparation)}
                    </TableCell>
                    <TableCell>{formatNumber(entry.complexity)}</TableCell>
                    <TableCell>
                      {entry.vetoAudit === null ? (
                        "—"
                      ) : entry.vetoAudit.passed ? (
                        <Badge>pass</Badge>
                      ) : (
                        <span
                          style={{
                            color: "var(--asi-danger, #b00)",
                            fontSize: "var(--asi-text-xs)",
                          }}
                        >
                          {entry.vetoAudit.findings
                            .filter((finding) => finding.status !== "ok")
                            .map((finding) => finding.ruleKey)
                            .join(", ") || "regressed"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {entry.leakedFields.length === 0 ? (
                        <Badge>clean</Badge>
                      ) : (
                        <span
                          style={{
                            color: "var(--asi-danger, #b00)",
                            fontSize: "var(--asi-text-xs)",
                          }}
                        >
                          LEAKED: {entry.leakedFields.join(", ")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>

          <div
            style={{
              display: "grid",
              gap: "var(--asi-space-3)",
              marginBlockStart: "var(--asi-space-4)",
            }}
          >
            <label htmlFor="decision-rationale" style={mutedStyle}>
              Decision rationale (journaled)
            </label>
            <textarea
              className="asi-input"
              id="decision-rationale"
              onChange={(event) => setRationale(event.target.value)}
              rows={3}
              style={{ inlineSize: "100%" }}
              value={rationale}
            />
            <div style={{ display: "flex", gap: "var(--asi-space-3)" }}>
              <Button
                disabled={busy}
                onClick={() => void decide(true)}
                variant="primary"
              >
                Keep &amp; promote best challenger
              </Button>
              <Button disabled={busy} onClick={() => void decide(false)}>
                Revert (do not promote)
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="qualifier-register">
        <h2 id="qualifier-register" style={sectionTitleStyle}>
          Register challenger
        </h2>
        <form
          onSubmit={(event) => void registerChallenger(event)}
          style={{
            display: "grid",
            gap: "var(--asi-space-3)",
            maxWidth: "48rem",
          }}
        >
          <Input
            aria-label="Challenger name"
            onChange={(event) => setRegisterName(event.target.value)}
            placeholder="Program name"
            required
            value={registerName}
          />
          <Select
            aria-label="Axis"
            onChange={(event) =>
              setRegisterAxis(event.target.value as "fit" | "actionability")
            }
            value={registerAxis}
          >
            <option value="fit">fit</option>
            <option value="actionability">actionability</option>
          </Select>
          <textarea
            aria-label="Program JSON"
            className="asi-input"
            onChange={(event) => setRegisterJson(event.target.value)}
            placeholder='{"version":1,"axis":"fit","components":[…],"hardVetoes":[…]}'
            rows={10}
            style={{ fontFamily: "var(--asi-font-mono)" }}
            value={registerJson}
          />
          <Button disabled={busy || registerName.trim() === ""} type="submit">
            Register
          </Button>
        </form>
      </section>

      <section aria-labelledby="qualifier-journal">
        <h2 id="qualifier-journal" style={sectionTitleStyle}>
          Experiment history journal
        </h2>
        <p style={mutedStyle}>
          Append-only; decisions appear as lineage children of the run they
          decide.
        </p>
        {journal.length === 0 ? (
          <EmptyState title="No experiment runs yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Created</TableHead>
                <TableHead scope="col">Kind</TableHead>
                <TableHead scope="col">Label</TableHead>
                <TableHead scope="col">Primary metric</TableHead>
                <TableHead scope="col">Decision</TableHead>
                <TableHead scope="col">Lineage parent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {journal.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    {new Date(run.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{run.kind}</TableCell>
                  <TableCell>{run.label}</TableCell>
                  <TableCell>
                    {run.primaryMetricValue === undefined
                      ? "—"
                      : `${run.primaryMetricName ?? ""} ${formatNumber(run.primaryMetricValue)}`}
                  </TableCell>
                  <TableCell>
                    {run.decision === undefined ? (
                      "—"
                    ) : (
                      <Badge>{run.keep ? `keep: ${run.decision}` : `revert: ${run.decision}`}</Badge>
                    )}
                  </TableCell>
                  <TableCell style={monoStyle}>
                    {run.lineageParentId === undefined
                      ? "—"
                      : `${run.lineageParentId.slice(0, 8)}…`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
