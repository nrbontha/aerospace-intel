"use client";

import { Button, Input, Select } from "@asi/ui";
import { useState, type FormEvent } from "react";

import { apiJson } from "@/components/csrf-client";

type CompanyAliasActionProps = Readonly<{
  companyId: string;
  canEdit: boolean;
  onCreated?: () => void;
}>;

const aliasTypes = [
  { value: "name", label: "Name" },
  { value: "trade", label: "Trade" },
  { value: "abbreviation", label: "Abbreviation" },
  { value: "former", label: "Former" },
] as const;

export function CompanyAliasAction({
  companyId,
  canEdit,
  onCreated,
}: CompanyAliasActionProps) {
  const [alias, setAlias] = useState("");
  const [aliasType, setAliasType] = useState<(typeof aliasTypes)[number]["value"]>(
    "name",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  if (!canEdit) return null;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await apiJson(
        `/api/v1/companies/${encodeURIComponent(companyId)}/aliases`,
        {
          method: "POST",
          body: JSON.stringify({ alias: alias.trim(), aliasType }),
        },
      );
      setAlias("");
      setNotice("Alias recorded. Company search now matches this name.");
      onCreated?.();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to record alias.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-form-grid" onSubmit={onSubmit}>
      <label className="admin-field" htmlFor="company-alias">
        <span className="admin-field__label">Add alias</span>
        <Input
          id="company-alias"
          maxLength={200}
          required
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
        />
      </label>
      <label className="admin-field" htmlFor="company-alias-type">
        <span className="admin-field__label">Alias type</span>
        <Select
          id="company-alias-type"
          value={aliasType}
          onChange={(event) =>
            setAliasType(
              event.target.value as (typeof aliasTypes)[number]["value"],
            )
          }
        >
          {aliasTypes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      <div className="admin-actions">
        <Button type="submit" disabled={busy || alias.trim() === ""}>
          Record alias
        </Button>
      </div>
      {error ? (
        <p className="admin-feedback" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="admin-feedback" data-tone="success" role="status">
          {notice}
        </p>
      ) : null}
    </form>
  );
}
