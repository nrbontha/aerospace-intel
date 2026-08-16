import { describe, expect, it } from "vitest";

import { dataSourceCreateSchema } from "@asi/contracts";

describe("data source creation contract", () => {
  it("accepts an independent source with no company relationship", () => {
    const result = dataSourceCreateSchema.safeParse({
      name: "Synthetic Public Registry",
      access: "public",
      ingestionMethod: "web_fetch",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an unsupported access policy", () => {
    const result = dataSourceCreateSchema.safeParse({
      name: "Synthetic Public Registry",
      access: "unrestricted_copying",
      ingestionMethod: "web_fetch",
    });

    expect(result.success).toBe(false);
  });
});
