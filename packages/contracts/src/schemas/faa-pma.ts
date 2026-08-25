import { z } from "zod";

import { dateSchema, instantSchema } from "../schemas.js";

export const faaPmaPublicUrl =
  "https://drs.faa.gov/browse/PMA/doctypeDetails" as const;

const nullableText = z.string().trim().min(1).max(10_000).nullable();
const searchText = z.string().trim().min(1).max(500);

/** One PMA result card extracted from the public FAA DRS guest UI. */
export const faaPmaRecordSchema = z.strictObject({
  recordId: z.string().trim().min(1).max(500),
  guidUrl: z.url().max(2_000),
  status: nullableText,
  subStatus: nullableText,
  holderName: nullableText,
  holderNumber: nullableText,
  fullAddress: nullableText,
  pmaPartNumber: nullableText,
  partName: nullableText,
  replacementPartNumber: nullableText,
  make: nullableText,
  models: z.array(z.string().trim().min(1).max(1_000)).max(500),
  supplementNumber: nullableText,
  supplementDate: dateSchema.nullable(),
  approvalBasis: nullableText,
  serviceOffice: nullableText,
  opr: nullableText,
  cfrReferences: z.array(z.string().trim().min(1).max(1_000)).max(100),
  comments: nullableText,
  renderedSourceText: z
    .string()
    .max(100_000)
    .refine((value) => value.trim().length > 0, "Rendered source text is empty"),
});

const faaPmaSearchFields = [
  "holderName",
  "holderNumber",
  "partNumber",
  "make",
  "model",
] as const;

/** A targeted DRS query. Exactly one supported public UI filter is allowed. */
export const faaPmaScrapeQuerySchema = z
  .strictObject({
    holderName: searchText.optional(),
    holderNumber: searchText.optional(),
    partNumber: searchText.optional(),
    make: searchText.optional(),
    model: searchText.optional(),
    maxRecords: z.coerce.number().int().min(1).max(25).default(25),
  })
  .superRefine((query, context) => {
    const suppliedFields = faaPmaSearchFields.filter(
      (field) => query[field] !== undefined,
    );
    if (suppliedFields.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one FAA PMA search field must be supplied",
      });
    }
  });

export const faaPmaScrapeSourceSchema = z.strictObject({
  publicUrl: z.literal(faaPmaPublicUrl),
  scrapedAt: instantSchema,
  retrievalMethod: z.literal("guest_browser_dom"),
  hydratedRecordUrl: z.url().max(2_000).optional(),
});

export const faaPmaScrapeResultSchema = z
  .strictObject({
    query: faaPmaScrapeQuerySchema,
    records: z.array(faaPmaRecordSchema).max(25),
    source: faaPmaScrapeSourceSchema,
  })
  .superRefine((result, context) => {
    if (result.records.length > result.query.maxRecords) {
      context.addIssue({
        code: "custom",
        path: ["records"],
        message: "FAA PMA result exceeds the requested record limit",
      });
    }
  });

export type FaaPmaRecord = z.infer<typeof faaPmaRecordSchema>;
export type FaaPmaScrapeQuery = z.infer<typeof faaPmaScrapeQuerySchema>;
export type FaaPmaScrapeSource = z.infer<typeof faaPmaScrapeSourceSchema>;
export type FaaPmaScrapeResult = z.infer<typeof faaPmaScrapeResultSchema>;
