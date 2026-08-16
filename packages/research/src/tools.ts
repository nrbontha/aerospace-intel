import { z } from "zod";

export const researchToolCatalog = {
  search_web: "network.search",
  fetch_url: "network.fetch",
  read_source_document: "source_document.read",
} as const;

export const researchToolNameValues = [
  "search_web",
  "fetch_url",
  "read_source_document",
] as const;
export const researchToolPermissionValues = [
  "network.search",
  "network.fetch",
  "source_document.read",
] as const;

export const researchToolNameSchema = z.enum(researchToolNameValues);
export const researchToolPermissionSchema = z.enum(
  researchToolPermissionValues,
);

export type ResearchToolName = z.infer<typeof researchToolNameSchema>;
export type ResearchToolPermission = z.infer<
  typeof researchToolPermissionSchema
>;
export type ResearchToolPermissionFor<Name extends ResearchToolName> =
  (typeof researchToolCatalog)[Name];

export const researchToolRetrySchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(5),
  initialDelayMs: z.number().int().min(0).max(30_000),
  maxDelayMs: z.number().int().min(0).max(60_000),
  backoff: z.enum(["fixed", "exponential"]),
});

export const researchToolIdempotencySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("input_hash") }),
  z.strictObject({
    mode: z.literal("explicit_key"),
    keyField: z.string().trim().min(1).max(100),
  }),
]);

export type ResearchToolRetry = z.infer<typeof researchToolRetrySchema>;
export type ResearchToolIdempotency = z.infer<
  typeof researchToolIdempotencySchema
>;

const runtimeSchemaSchema = z.custom<z.ZodType>(
  (value) => value instanceof z.ZodType,
  "Expected a Zod runtime schema",
);

const manifestCommonShape = {
  schema: z.strictObject({
    input: runtimeSchemaSchema,
    output: runtimeSchemaSchema,
  }),
  timeoutMs: z.number().int().min(100).max(30_000),
  retry: researchToolRetrySchema,
  idempotency: researchToolIdempotencySchema,
} as const;

export const researchToolManifestSchema = z.discriminatedUnion("name", [
  z.strictObject({
    ...manifestCommonShape,
    name: z.literal("search_web"),
    permission: z.literal("network.search"),
  }),
  z.strictObject({
    ...manifestCommonShape,
    name: z.literal("fetch_url"),
    permission: z.literal("network.fetch"),
  }),
  z.strictObject({
    ...manifestCommonShape,
    name: z.literal("read_source_document"),
    permission: z.literal("source_document.read"),
  }),
]);

export const researchToolManifestCatalogSchema = z
  .array(researchToolManifestSchema)
  .max(researchToolNameValues.length)
  .superRefine((manifests, context) => {
    const seen = new Set<ResearchToolName>();
    for (const [index, manifest] of manifests.entries()) {
      if (seen.has(manifest.name)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate research tool manifest: ${manifest.name}`,
          path: [index, "name"],
        });
      }
      seen.add(manifest.name);
    }
  });

export interface ResearchToolManifest<
  Name extends ResearchToolName = ResearchToolName,
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
  readonly schema: {
    readonly input: InputSchema;
    readonly output: OutputSchema;
  };
  readonly permission: ResearchToolPermissionFor<Name>;
  readonly timeoutMs: number;
  readonly retry: ResearchToolRetry;
  readonly idempotency: ResearchToolIdempotency;
}

export type ValidatedResearchToolManifest = z.infer<
  typeof researchToolManifestSchema
>;
export type ValidatedResearchToolManifestCatalog = z.infer<
  typeof researchToolManifestCatalogSchema
>;

export function defineResearchToolManifest<
  const Name extends ResearchToolName,
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  manifest: ResearchToolManifest<Name, InputSchema, OutputSchema>,
): ResearchToolManifest<Name, InputSchema, OutputSchema> {
  researchToolManifestSchema.parse(manifest);
  return manifest;
}

export function parseResearchToolManifestCatalog(
  value: unknown,
): ValidatedResearchToolManifestCatalog {
  return researchToolManifestCatalogSchema.parse(value);
}

export function parseResearchToolInput<InputSchema extends z.ZodType>(
  manifest: ResearchToolManifest<ResearchToolName, InputSchema, z.ZodType>,
  value: unknown,
): z.output<InputSchema> {
  return manifest.schema.input.parse(value) as z.output<InputSchema>;
}

export function parseResearchToolOutput<OutputSchema extends z.ZodType>(
  manifest: ResearchToolManifest<ResearchToolName, z.ZodType, OutputSchema>,
  value: unknown,
): z.output<OutputSchema> {
  return manifest.schema.output.parse(value) as z.output<OutputSchema>;
}
