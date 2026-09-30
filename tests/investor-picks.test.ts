import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  investorPickCreateInputSchema,
  investorPickUpdateInputSchema,
  investorReferenceImportInputSchema,
  investorReferenceSetDtoSchema,
} from "@asi/contracts";
import {
  parseInvestorPicksCliOptions,
  validateInvestorPicksDestination,
} from "../scripts/investor-picks.mjs";

const listInvestorPicksForUser = vi.fn();
const requireUser = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn(),
  requireUser: (...args: unknown[]) => requireUser(...args),
  verifyCsrfRequest: vi.fn(),
}));
vi.mock("@/lib/investor-picks.server", () => ({
  createInvestorPickForAdmin: vi.fn(),
  listInvestorPicksForUser: (...args: unknown[]) =>
    listInvestorPicksForUser(...args),
}));

// The route loads after mocks so its authorization boundary is isolated from DB work.
const { GET } = await import(
  "../apps/web/src/app/api/v1/investor-picks/route.js"
);

describe("investor pick contracts", () => {
  it("rejects name-only input for an existing source selection", () => {
    expect(
      investorPickCreateInputSchema.safeParse({
        mode: "existing",
        name: "Not an existing source selection",
      }).success,
    ).toBe(false);
  });

  it("rejects an update with no requested changes", () => {
    expect(investorPickUpdateInputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts only the current Golden import set", () => {
    expect(investorReferenceImportInputSchema.safeParse({ set: "golden" }).success).toBe(
      true,
    );
    for (const set of ["booie", "all", "ma-pipeline-20260926"]) {
      expect(investorReferenceImportInputSchema.safeParse({ set }).success).toBe(false);
    }
  });

  it("exposes both immutable source snapshots as Golden metadata", () => {
    const metadata = {
      key: "golden",
      label: "Golden",
      snapshotKeys: ["golden-set-v01", "booie-original29-2026-09-09"],
      available: true,
      memberCount: 47,
      importedMemberCount: 47,
    };
    expect(investorReferenceSetDtoSchema.safeParse(metadata).success).toBe(true);
    expect(
      investorReferenceSetDtoSchema.safeParse({
        ...metadata,
        snapshotKey: "golden-set-v01",
      }).success,
    ).toBe(false);
  });
});

describe("investor picks import CLI guards", () => {
  const importArgs = [
    "--set",
    "golden",
    "--expected-host",
    "db.example.test",
    "--expected-database",
    "asi",
    "--apply",
  ];

  it("requires an explicit apply guard before accepting options", () => {
    expect(() =>
      parseInvestorPicksCliOptions(
        importArgs.filter((argument) => argument !== "--apply"),
      ),
    ).toThrow();
  });

  it.each(["booie", "all"])("rejects retired %s set selector", (set) => {
    expect(() =>
      parseInvestorPicksCliOptions([
        "--set",
        set,
        "--expected-host",
        "db.example.test",
        "--expected-database",
        "asi",
        "--apply",
      ]),
    ).toThrow();
  });

  it("guards the effective destination before a database is opened", () => {
    expect(() =>
      validateInvestorPicksDestination(undefined, "db.example.test", "asi"),
    ).toThrow();
    expect(() =>
      validateInvestorPicksDestination(
        "postgresql://private-user:private-password@wrong.example.test:5432/asi",
        "db.example.test",
        "asi",
      ),
    ).toThrow();
    expect(() =>
      validateInvestorPicksDestination(
        "postgresql://private-user:private-password@db.example.test:5432/wrong",
        "db.example.test",
        "asi",
      ),
    ).toThrow();
    expect(() =>
      validateInvestorPicksDestination(
        "postgresql://fixture@expected.example/asi?host=other.example",
        "expected.example",
        "asi",
      ),
    ).toThrow();
  });
});

describe("investor pick API authorization boundaries", () => {
  beforeEach(() => {
    listInvestorPicksForUser.mockReset();
    requireUser.mockReset();
  });

  it("does not disclose archived picks to an authenticated viewer", async () => {
    requireUser.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      role: "viewer",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/v1/investor-picks?includeInactive=true",
      ),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
    expect(listInvestorPicksForUser).not.toHaveBeenCalled();
  });
});
