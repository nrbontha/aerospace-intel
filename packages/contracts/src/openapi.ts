export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: readonly { readonly url: string }[];
  readonly security: readonly Record<string, readonly string[]>[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: Readonly<Record<string, unknown>>;
}

const json = { "application/json": {} } as const;
const csrf = {
  name: "x-csrf-token",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 1 },
  description: "CSRF token required for authenticated mutations.",
} as const;
const idParameter = (name: string) =>
  ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }) as const;
const body = (schema: string) =>
  ({
    required: true,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  }) as const;
const ok = (schema: string, description = "Successful response") =>
  ({
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  }) as const;
const errors = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
} as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Aerospace Supplier Intelligence API",
    version: "1.0.0",
    description:
      "Version 1 REST API. Except for health and login, operations require an authenticated session. Mutations additionally require CSRF and role authorization.",
  },
  servers: [{ url: "/" }],
  security: [{ sessionCookie: [] }],
  paths: {
    "/api/v1/health": {
      get: {
        operationId: "getHealth",
        tags: ["Health"],
        security: [],
        responses: {
          "200": ok("HealthEnvelope"),
          "503": ok("ErrorEnvelope", "Service unavailable"),
        },
      },
    },
    "/api/v1/health/ready": {
      get: {
        operationId: "getReadiness",
        tags: ["Health"],
        security: [],
        responses: {
          "200": ok("HealthEnvelope"),
          "503": ok("ErrorEnvelope", "Service unavailable"),
        },
      },
    },
    "/api/v1/auth/login": {
      post: {
        operationId: "login",
        tags: ["Auth"],
        security: [],
        requestBody: body("LoginRequest"),
        responses: {
          "200": ok("UserEnvelope"),
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        operationId: "logout",
        tags: ["Auth"],
        parameters: [csrf],
        responses: {
          "204": { description: "Session revoked" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
    },
    "/api/v1/auth/me": {
      get: {
        operationId: "getCurrentUser",
        tags: ["Auth"],
        responses: { "200": ok("UserEnvelope"), ...errors },
      },
    },
    "/api/v1/openapi": {
      get: {
        operationId: "getOpenApi",
        tags: ["Health"],
        responses: {
          "200": { description: "OpenAPI 3.1 document", content: json },
          ...errors,
        },
      },
    },
    "/api/v1/companies": {
      get: {
        operationId: "listCompanies",
        tags: ["Companies"],
        parameters: [
          { $ref: "#/components/parameters/Page" },
          { $ref: "#/components/parameters/PageSize" },
          {
            name: "query",
            in: "query",
            description: "Matches legal name, display name, and aliases.",
            schema: { type: "string", maxLength: 200 },
          },
          {
            name: "status",
            in: "query",
            schema: { $ref: "#/components/schemas/CompanyStatus" },
          },
        ],
        responses: { "200": ok("CompanyListEnvelope"), ...errors },
      },
    },
    "/api/v1/companies/{companyId}": {
      get: {
        operationId: "getCompany",
        tags: ["Companies"],
        parameters: [idParameter("companyId")],
        responses: { "200": ok("CompanySuccessEnvelope"), ...errors },
      },
    },
    "/api/v1/companies/{companyId}/aliases": {
      post: {
        operationId: "createCompanyAlias",
        tags: ["Companies"],
        parameters: [idParameter("companyId"), csrf],
        requestBody: body("CompanyAliasCreate"),
        responses: {
          "201": ok("CompanyAliasEnvelope", "Created"),
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/sources": {
      get: {
        operationId: "listSources",
        tags: ["Sources"],
        parameters: [
          { $ref: "#/components/parameters/Page" },
          { $ref: "#/components/parameters/PageSize" },
        ],
        responses: { "200": ok("DataSourceListEnvelope"), ...errors },
      },
      post: {
        operationId: "createSource",
        tags: ["Sources"],
        parameters: [csrf],
        requestBody: body("DataSourceCreate"),
        responses: { "201": ok("DataSourceEnvelope", "Created"), ...errors },
      },
    },
    "/api/v1/sources/{sourceId}": {
      get: {
        operationId: "getSource",
        tags: ["Sources"],
        parameters: [idParameter("sourceId")],
        responses: { "200": ok("DataSourceEnvelope"), ...errors },
      },
    },
    "/api/v1/research-runs": {
      get: {
        operationId: "listResearchRuns",
        tags: ["Research"],
        parameters: [
          { $ref: "#/components/parameters/Page" },
          { $ref: "#/components/parameters/PageSize" },
        ],
        responses: { "200": ok("ResearchRunListEnvelope"), ...errors },
      },
      post: {
        operationId: "createResearchRun",
        tags: ["Research"],
        parameters: [csrf],
        requestBody: body("ResearchRunCreate"),
        responses: { "202": ok("ResearchRunEnvelope", "Queued"), ...errors },
      },
    },
    "/api/v1/research-runs/{researchRunId}": {
      get: {
        operationId: "getResearchRun",
        tags: ["Research"],
        parameters: [idParameter("researchRunId")],
        responses: { "200": ok("ResearchRunEnvelope"), ...errors },
      },
    },
    "/api/v1/research-runs/{researchRunId}/events": {
      get: {
        operationId: "streamResearchRun",
        tags: ["Research"],
        parameters: [idParameter("researchRunId")],
        responses: {
          "200": {
            description:
              "Server-sent snapshots of persisted research-run state",
            content: { "text/event-stream": {} },
          },
          ...errors,
        },
      },
    },
    "/api/v1/research-runs/{researchRunId}/cancel": {
      post: {
        operationId: "cancelResearchRun",
        tags: ["Research"],
        parameters: [idParameter("researchRunId"), csrf],
        responses: {
          "200": ok("ResearchRunEnvelope"),
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/proposals": {
      get: {
        operationId: "listProposals",
        tags: ["Proposals"],
        parameters: [
          { $ref: "#/components/parameters/Page" },
          { $ref: "#/components/parameters/PageSize" },
          {
            name: "status",
            in: "query",
            schema: { $ref: "#/components/schemas/ProposalStatus" },
          },
        ],
        responses: { "200": ok("ProposalListEnvelope"), ...errors },
      },
    },
    "/api/v1/proposals/bulk": {
      post: {
        operationId: "bulkReviewProposals",
        tags: ["Proposals"],
        parameters: [csrf],
        responses: {
          "200": ok("ProposalListEnvelope"),
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/proposals/{proposalId}": {
      get: {
        operationId: "getProposal",
        tags: ["Proposals"],
        parameters: [idParameter("proposalId")],
        responses: { "200": ok("ProposalEnvelope"), ...errors },
      },
      patch: {
        operationId: "reviewProposal",
        tags: ["Proposals"],
        parameters: [idParameter("proposalId"), csrf],
        requestBody: body("ProposalDecision"),
        responses: {
          "200": ok("ProposalEnvelope"),
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/imports": {
      get: {
        operationId: "listImports",
        tags: ["Imports"],
        parameters: [
          { $ref: "#/components/parameters/Page" },
          { $ref: "#/components/parameters/PageSize" },
        ],
        responses: { "200": ok("ImportListEnvelope"), ...errors },
      },
      post: {
        operationId: "createImport",
        tags: ["Imports"],
        parameters: [csrf],
        responses: { "200": ok("ImportEnvelope"), ...errors },
      },
    },
    "/api/v1/imports/{importId}": {
      get: {
        operationId: "getImport",
        tags: ["Imports"],
        parameters: [idParameter("importId")],
        responses: { "200": ok("ImportEnvelope"), ...errors },
      },
    },
    "/api/v1/exports": {
      get: {
        operationId: "exportCatalog",
        tags: ["Exports"],
        parameters: [
          {
            name: "entity",
            in: "query",
            required: true,
            schema: {
              type: "string",
              enum: [
                "companies",
                "facilities",
                "contacts",
                "platforms",
                "parts",
                "qualifications",
                "data_sources",
              ],
            },
          },
          {
            name: "format",
            in: "query",
            schema: { type: "string", enum: ["csv", "jsonl"] },
          },
        ],
        responses: {
          "200": {
            description: "Immediate CSV or JSONL download",
            content: {
              "text/csv": {},
              "application/x-ndjson": {},
            },
          },
          ...errors,
        },
      },
      post: {
        operationId: "exportCatalogWithCsrf",
        tags: ["Exports"],
        parameters: [csrf],
        responses: {
          "200": {
            description: "Immediate CSV or JSONL download",
            content: {
              "text/csv": {},
              "application/x-ndjson": {},
            },
          },
          ...errors,
        },
      },
    },
    "/api/v1/admin/users": {
      get: {
        operationId: "listUsers",
        tags: ["Admin"],
        description: "Admin role required.",
        parameters: [
          { $ref: "#/components/parameters/Page" },
          { $ref: "#/components/parameters/PageSize" },
        ],
        responses: { "200": ok("UserListEnvelope"), ...errors },
      },
      post: {
        operationId: "createUser",
        tags: ["Admin"],
        parameters: [csrf],
        requestBody: body("UserCreate"),
        responses: { "201": ok("UserEnvelope", "Created"), ...errors },
      },
    },
    "/api/v1/admin/users/{userId}": {
      get: {
        operationId: "getUser",
        tags: ["Admin"],
        parameters: [idParameter("userId")],
        responses: { "200": ok("UserEnvelope"), ...errors },
      },
      patch: {
        operationId: "updateUser",
        tags: ["Admin"],
        parameters: [idParameter("userId"), csrf],
        requestBody: body("UserUpdate"),
        responses: {
          "200": ok("UserEnvelope"),
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/admin/users/{userId}/reset-password": {
      post: {
        operationId: "resetUserPassword",
        tags: ["Admin"],
        parameters: [idParameter("userId"), csrf],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["password"],
                properties: {
                  password: { type: "string", minLength: 12, maxLength: 1000 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Password reset", content: json },
          ...errors,
        },
      },
    },
    "/api/v1/admin/users/{userId}/sessions": {
      delete: {
        operationId: "revokeUserSessions",
        tags: ["Admin"],
        parameters: [idParameter("userId"), csrf],
        responses: {
          "200": { description: "Active sessions revoked", content: json },
          ...errors,
        },
      },
    },
    "/api/v1/facilities": {
      get: {
        operationId: "listFacilities",
        tags: ["Catalog"],
        responses: { "200": { description: "Facility list", content: json }, ...errors },
      },
    },
    "/api/v1/facilities/{facilityId}": {
      get: {
        operationId: "getFacility",
        tags: ["Catalog"],
        parameters: [idParameter("facilityId")],
        responses: { "200": { description: "Facility detail", content: json }, ...errors },
      },
    },
    "/api/v1/platforms": {
      get: {
        operationId: "listPlatforms",
        tags: ["Catalog"],
        responses: { "200": { description: "Platform list", content: json }, ...errors },
      },
    },
    "/api/v1/platforms/{platformId}": {
      get: {
        operationId: "getPlatform",
        tags: ["Catalog"],
        parameters: [idParameter("platformId")],
        responses: { "200": { description: "Platform detail including variants", content: json }, ...errors },
      },
    },
    "/api/v1/parts": {
      get: {
        operationId: "listParts",
        tags: ["Catalog"],
        responses: { "200": { description: "Part list", content: json }, ...errors },
      },
    },
    "/api/v1/parts/{partId}": {
      get: {
        operationId: "getPart",
        tags: ["Catalog"],
        parameters: [idParameter("partId")],
        responses: { "200": { description: "Part detail", content: json }, ...errors },
      },
    },
    "/api/v1/subsystems": {
      get: {
        operationId: "listSubsystems",
        tags: ["Catalog"],
        responses: { "200": { description: "Subsystem list", content: json }, ...errors },
      },
    },
    "/api/v1/subsystems/{subsystemId}": {
      get: {
        operationId: "getSubsystem",
        tags: ["Catalog"],
        parameters: [idParameter("subsystemId")],
        responses: { "200": { description: "Subsystem detail", content: json }, ...errors },
      },
    },
    "/api/v1/customers": {
      get: {
        operationId: "listCustomers",
        tags: ["Catalog"],
        responses: { "200": { description: "Customer-role company list", content: json }, ...errors },
      },
    },
    "/api/v1/customers/{customerId}": {
      get: {
        operationId: "getCustomer",
        tags: ["Catalog"],
        parameters: [idParameter("customerId")],
        responses: { "200": { description: "Customer-role company detail", content: json }, ...errors },
      },
    },
    "/api/v1/qualifications": {
      get: {
        operationId: "listQualifications",
        tags: ["Catalog"],
        responses: { "200": { description: "Qualification list", content: json }, ...errors },
      },
    },
    "/api/v1/qualifications/{qualificationId}": {
      get: {
        operationId: "getQualification",
        tags: ["Catalog"],
        parameters: [idParameter("qualificationId")],
        responses: { "200": { description: "Qualification detail", content: json }, ...errors },
      },
    },
    "/api/v1/capabilities": {
      get: {
        operationId: "listCapabilities",
        tags: ["Catalog"],
        responses: { "200": { description: "Capability list", content: json }, ...errors },
      },
    },
    "/api/v1/capabilities/{capabilityId}": {
      get: {
        operationId: "getCapability",
        tags: ["Catalog"],
        parameters: [idParameter("capabilityId")],
        responses: { "200": { description: "Capability detail", content: json }, ...errors },
      },
    },
    "/api/v1/certifications": {
      get: {
        operationId: "listCertifications",
        tags: ["Catalog"],
        responses: { "200": { description: "Certification list", content: json }, ...errors },
      },
    },
    "/api/v1/certifications/{certificationId}": {
      get: {
        operationId: "getCertification",
        tags: ["Catalog"],
        parameters: [idParameter("certificationId")],
        responses: { "200": { description: "Certification detail", content: json }, ...errors },
      },
    },
    "/api/v1/analytics/dashboard": {
      get: {
        operationId: "getDashboardMetrics",
        tags: ["Analytics"],
        responses: { "200": { description: "Dashboard coverage metrics", content: json }, ...errors },
      },
    },
    "/api/v1/analytics/series": {
      get: {
        operationId: "getDashboardSeries",
        tags: ["Analytics"],
        responses: { "200": { description: "Daily research and spend series", content: json }, ...errors },
      },
    },
    "/api/v1/analytics/scores": {
      get: {
        operationId: "getScores",
        tags: ["Analytics"],
        responses: { "200": { description: "Supplier or source scorecard", content: json }, ...errors },
      },
    },
    "/api/v1/merges": {
      get: {
        operationId: "listMerges",
        tags: ["Merges"],
        responses: { "200": { description: "Company merge events", content: json }, ...errors },
      },
      post: {
        operationId: "mergeCompanies",
        tags: ["Merges"],
        parameters: [csrf],
        responses: {
          "200": { description: "Merge applied", content: json },
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/merges/{mergeId}/revert": {
      post: {
        operationId: "revertMerge",
        tags: ["Merges"],
        parameters: [idParameter("mergeId"), csrf],
        responses: {
          "200": { description: "Merge reverted", content: json },
          ...errors,
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/v1/ops/status": {
      get: {
        operationId: "getOpsStatus",
        tags: ["Ops"],
        description: "Admin role required.",
        responses: { "200": { description: "Queue drain and storage reconciliation", content: json }, ...errors },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "asi_session",
        description: "Secure, httpOnly, SameSite=Lax session cookie.",
      },
    },
    parameters: {
      Page: {
        name: "page",
        in: "query",
        schema: { type: "integer", minimum: 1, default: 1 },
      },
      PageSize: {
        name: "pageSize",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
    },
    responses: {
      BadRequest: {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
      Unauthorized: {
        description: "Authentication required or session invalid",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
      Forbidden: {
        description: "Insufficient role or invalid CSRF token",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
      NotFound: {
        description: "Resource not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
      Conflict: {
        description: "Resource state conflict",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorEnvelope" },
          },
        },
      },
    },
    schemas: {
      Uuid: { type: "string", format: "uuid" },
      Instant: { type: "string", format: "date-time" },
      JsonValue: {},
      Role: { type: "string", enum: ["admin", "analyst", "viewer"] },
      SourceAccess: {
        type: "string",
        enum: ["public", "authorized", "restricted_metadata_only"],
      },
      SourceIngestion: {
        type: "string",
        enum: ["manual", "upload", "web_fetch", "api", "import"],
      },
      CompanyStatus: {
        type: "string",
        enum: ["active", "inactive", "acquired", "defunct", "unknown"],
      },
      RecordStatus: { type: "string", enum: ["draft", "active", "archived"] },
      ResearchRunStatus: {
        type: "string",
        enum: ["queued", "running", "succeeded", "failed", "cancelled"],
      },
      ProposalStatus: {
        type: "string",
        enum: ["pending", "accepted", "rejected", "superseded"],
      },
      PageMeta: {
        type: "object",
        additionalProperties: false,
        required: ["page", "pageSize", "totalItems", "totalPages"],
        properties: {
          page: { type: "integer", minimum: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 100 },
          totalItems: { type: "integer", minimum: 0 },
          totalPages: { type: "integer", minimum: 0 },
        },
      },
      ErrorEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: {
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "bad_request",
                  "unauthorized",
                  "forbidden",
                  "not_found",
                  "conflict",
                  "validation_failed",
                  "rate_limited",
                  "internal_error",
                ],
              },
              message: { type: "string" },
              details: {},
            },
          },
        },
      },
      HealthEnvelope: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: {
            type: "object",
            additionalProperties: false,
            required: ["status", "version"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              version: { type: "string" },
            },
          },
        },
      },
      LoginRequest: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 12, maxLength: 1000 },
        },
      },
      Identifier: {
        type: "object",
        additionalProperties: false,
        required: ["type", "value"],
        properties: {
          type: {
            type: "string",
            enum: [
              "cage",
              "duns",
              "uei",
              "lei",
              "naics",
              "sic",
              "ticker",
              "internal",
            ],
          },
          value: { type: "string", minLength: 1, maxLength: 100 },
          issuingCountry: { type: "string", pattern: "^[A-Z]{2}$" },
        },
      },
      CompanyCreate: {
        type: "object",
        additionalProperties: false,
        required: ["legalName"],
        properties: {
          legalName: { type: "string", minLength: 1, maxLength: 300 },
          commonName: { type: "string", minLength: 1, maxLength: 300 },
          description: { type: "string", maxLength: 10000 },
          websiteUrl: { type: "string", format: "uri" },
          headquartersCountry: { type: "string", pattern: "^[A-Z]{2}$" },
          status: { $ref: "#/components/schemas/CompanyStatus" },
          ownershipType: {
            type: "string",
            enum: [
              "private",
              "public",
              "subsidiary",
              "government",
              "joint_venture",
              "cooperative",
              "unknown",
            ],
          },
          parentCompanyId: { $ref: "#/components/schemas/Uuid" },
          identifiers: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/Identifier" },
          },
        },
      },
      CompanyUpdate: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          legalName: { type: "string", minLength: 1, maxLength: 300 },
          commonName: { type: "string", minLength: 1, maxLength: 300 },
          description: { type: "string", maxLength: 10000 },
          websiteUrl: { type: "string", format: "uri" },
          headquartersCountry: { type: "string", pattern: "^[A-Z]{2}$" },
          status: { $ref: "#/components/schemas/CompanyStatus" },
          ownershipType: {
            type: "string",
            enum: [
              "private",
              "public",
              "subsidiary",
              "government",
              "joint_venture",
              "cooperative",
              "unknown",
            ],
          },
          parentCompanyId: { $ref: "#/components/schemas/Uuid" },
          identifiers: {
            type: "array",
            maxItems: 100,
            items: { $ref: "#/components/schemas/Identifier" },
          },
        },
      },
      Company: {
        allOf: [
          { $ref: "#/components/schemas/CompanyCreate" },
          {
            type: "object",
            required: ["id", "createdAt", "updatedAt"],
            properties: {
              id: { $ref: "#/components/schemas/Uuid" },
              createdAt: { $ref: "#/components/schemas/Instant" },
              updatedAt: { $ref: "#/components/schemas/Instant" },
            },
          },
        ],
      },
      CompanyAliasCreate: {
        type: "object",
        additionalProperties: false,
        required: ["alias"],
        properties: {
          alias: { type: "string", minLength: 1, maxLength: 200 },
          aliasType: {
            type: "string",
            enum: ["name", "trade", "abbreviation", "former"],
          },
          isPrimary: { type: "boolean" },
        },
      },
      CompanyAlias: {
        type: "object",
        additionalProperties: false,
        required: ["id", "companyId", "alias", "aliasType", "isPrimary", "createdAt"],
        properties: {
          id: { $ref: "#/components/schemas/Uuid" },
          companyId: { $ref: "#/components/schemas/Uuid" },
          alias: { type: "string", minLength: 1, maxLength: 200 },
          aliasType: {
            type: "string",
            enum: ["name", "trade", "abbreviation", "former"],
          },
          isPrimary: { type: "boolean" },
          createdAt: { $ref: "#/components/schemas/Instant" },
        },
      },
      DataSourceCreate: {
        type: "object",
        additionalProperties: false,
        required: ["name", "access", "ingestionMethod"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          description: { type: "string", maxLength: 10000 },
          homepageUrl: { type: "string", format: "uri" },
          access: { $ref: "#/components/schemas/SourceAccess" },
          ingestionMethod: { $ref: "#/components/schemas/SourceIngestion" },
          status: { $ref: "#/components/schemas/RecordStatus" },
          metadata: { type: "object", additionalProperties: true },
        },
      },
      DataSourceUpdate: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 300 },
          description: { type: "string", maxLength: 10000 },
          homepageUrl: { type: "string", format: "uri" },
          access: { $ref: "#/components/schemas/SourceAccess" },
          ingestionMethod: { $ref: "#/components/schemas/SourceIngestion" },
          status: { $ref: "#/components/schemas/RecordStatus" },
          metadata: { type: "object", additionalProperties: true },
        },
      },
      DataSource: {
        allOf: [
          { $ref: "#/components/schemas/DataSourceCreate" },
          {
            type: "object",
            required: ["id", "createdAt", "updatedAt"],
            properties: {
              id: { $ref: "#/components/schemas/Uuid" },
              createdAt: { $ref: "#/components/schemas/Instant" },
              updatedAt: { $ref: "#/components/schemas/Instant" },
            },
          },
        ],
      },
      EntityReference: {
        type: "object",
        additionalProperties: false,
        required: ["type", "id"],
        properties: {
          type: {
            type: "string",
            enum: [
              "company",
              "facility",
              "contact",
              "platform",
              "part",
              "qualification",
              "data_source",
            ],
          },
          id: { $ref: "#/components/schemas/Uuid" },
        },
      },
      ResearchTarget: {
        type: "object",
        additionalProperties: false,
        required: ["type", "id", "objective"],
        properties: {
          type: {
            type: "string",
            enum: [
              "company",
              "facility",
              "contact",
              "platform",
              "part",
              "qualification",
              "data_source",
            ],
          },
          id: { $ref: "#/components/schemas/Uuid" },
          objective: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
      ResearchRunCreate: {
        type: "object",
        additionalProperties: false,
        required: ["targets"],
        properties: {
          targets: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { $ref: "#/components/schemas/ResearchTarget" },
          },
          requestedModel: { type: "string" },
          maxAttempts: { type: "integer", minimum: 1, maximum: 10, default: 3 },
          maxCostUsd: { type: "number", minimum: 0, maximum: 10000 },
          metadata: { type: "object", additionalProperties: true },
        },
      },
      ResearchRun: {
        allOf: [
          { $ref: "#/components/schemas/ResearchRunCreate" },
          {
            type: "object",
            required: ["id", "status", "progress", "createdAt", "updatedAt"],
            properties: {
              id: { $ref: "#/components/schemas/Uuid" },
              status: { $ref: "#/components/schemas/ResearchRunStatus" },
              progress: { type: "number", minimum: 0, maximum: 1 },
              createdAt: { $ref: "#/components/schemas/Instant" },
              updatedAt: { $ref: "#/components/schemas/Instant" },
            },
          },
        ],
      },
      ProposalCreate: {
        type: "object",
        additionalProperties: false,
        required: [
          "researchRunId",
          "observationId",
          "target",
          "field",
          "proposedValue",
          "rationale",
        ],
        properties: {
          researchRunId: { $ref: "#/components/schemas/Uuid" },
          observationId: { $ref: "#/components/schemas/Uuid" },
          target: { $ref: "#/components/schemas/EntityReference" },
          field: { type: "string", minLength: 1 },
          proposedValue: {},
          rationale: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      ProposalDecision: {
        type: "object",
        additionalProperties: false,
        properties: { note: { type: "string", maxLength: 10000 } },
      },
      Proposal: {
        allOf: [
          { $ref: "#/components/schemas/ProposalCreate" },
          {
            type: "object",
            required: ["id", "status", "createdAt", "updatedAt"],
            properties: {
              id: { $ref: "#/components/schemas/Uuid" },
              status: { $ref: "#/components/schemas/ProposalStatus" },
              createdAt: { $ref: "#/components/schemas/Instant" },
              updatedAt: { $ref: "#/components/schemas/Instant" },
            },
          },
        ],
      },
      ImportCreate: {
        type: "object",
        additionalProperties: false,
        required: [
          "entity",
          "format",
          "storageKey",
          "fileName",
          "contentSha256",
        ],
        properties: {
          entity: {
            type: "string",
            enum: [
              "companies",
              "facilities",
              "contacts",
              "platforms",
              "parts",
              "qualifications",
              "data_sources",
            ],
          },
          format: { type: "string", enum: ["csv", "jsonl", "xlsx"] },
          storageKey: { type: "string" },
          fileName: { type: "string" },
          contentSha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
          dryRun: { type: "boolean", default: false },
        },
      },
      Import: {
        allOf: [
          { $ref: "#/components/schemas/ImportCreate" },
          {
            type: "object",
            required: [
              "id",
              "status",
              "processedRows",
              "acceptedRows",
              "rejectedRows",
              "createdAt",
              "updatedAt",
            ],
            properties: {
              id: { $ref: "#/components/schemas/Uuid" },
              status: {
                type: "string",
                enum: [
                  "queued",
                  "validating",
                  "ready",
                  "processing",
                  "completed",
                  "failed",
                  "cancelled",
                ],
              },
              processedRows: { type: "integer", minimum: 0 },
              acceptedRows: { type: "integer", minimum: 0 },
              rejectedRows: { type: "integer", minimum: 0 },
              createdAt: { $ref: "#/components/schemas/Instant" },
              updatedAt: { $ref: "#/components/schemas/Instant" },
            },
          },
        ],
      },
      ExportCreate: {
        type: "object",
        additionalProperties: false,
        required: ["entity", "format"],
        properties: {
          entity: { type: "string" },
          format: { type: "string", enum: ["csv", "jsonl"] },
          filters: { type: "object", additionalProperties: true },
        },
      },
      Export: {
        allOf: [
          { $ref: "#/components/schemas/ExportCreate" },
          {
            type: "object",
            required: ["id", "status", "createdAt", "updatedAt"],
            properties: {
              id: { $ref: "#/components/schemas/Uuid" },
              status: {
                type: "string",
                enum: [
                  "queued",
                  "processing",
                  "completed",
                  "failed",
                  "expired",
                ],
              },
              storageKey: { type: "string" },
              createdAt: { $ref: "#/components/schemas/Instant" },
              updatedAt: { $ref: "#/components/schemas/Instant" },
            },
          },
        ],
      },
      UserCreate: {
        type: "object",
        additionalProperties: false,
        required: ["email", "displayName", "password", "role"],
        properties: {
          email: { type: "string", format: "email" },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          password: {
            type: "string",
            minLength: 12,
            maxLength: 1000,
            writeOnly: true,
          },
          role: { $ref: "#/components/schemas/Role" },
        },
      },
      UserUpdate: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          role: { $ref: "#/components/schemas/Role" },
          disabled: { type: "boolean" },
        },
      },
      User: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "email",
          "displayName",
          "role",
          "disabled",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { $ref: "#/components/schemas/Uuid" },
          email: { type: "string", format: "email" },
          displayName: { type: "string" },
          role: { $ref: "#/components/schemas/Role" },
          disabled: { type: "boolean" },
          createdAt: { $ref: "#/components/schemas/Instant" },
          updatedAt: { $ref: "#/components/schemas/Instant" },
        },
      },
      CompanyEnvelope: { $ref: "#/components/schemas/CompanySuccessEnvelope" },
      CompanySuccessEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Company" } },
      },
      CompanyAliasEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/CompanyAlias" } },
      },
      DataSourceEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/DataSource" } },
      },
      ResearchRunEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/ResearchRun" } },
      },
      ProposalEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Proposal" } },
      },
      ImportEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Import" } },
      },
      ExportEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Export" } },
      },
      UserEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/User" } },
      },
      CompanyListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/Company" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      DataSourceListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/DataSource" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      ResearchRunListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/ResearchRun" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      ProposalListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/Proposal" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      ImportListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/Import" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      ExportListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/Export" },
          },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
      UserListEnvelope: {
        type: "object",
        required: ["data", "meta"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/User" } },
          meta: { $ref: "#/components/schemas/PageMeta" },
        },
      },
    },
  },
} as const satisfies OpenApiDocument;

export const openApiJsonContentType = json;
