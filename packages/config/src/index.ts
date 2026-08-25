import { z } from "zod";

const blankToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalTrimmedString = (schema: z.ZodString) =>
  z.preprocess(blankToUndefined, schema.trim().optional());

const positiveNumberWithDefault = (defaultValue: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().finite().positive().default(defaultValue),
  );

const positiveIntegerWithDefault = (defaultValue: number, maximum: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().max(maximum).default(defaultValue),
  );

const optionalBoolean = z.preprocess((value) => {
  const normalized = blankToUndefined(value);

  if (typeof normalized !== "string") {
    return normalized;
  }

  switch (normalized.toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return normalized;
  }
}, z.boolean().optional());

const postgresUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "postgres:" ||
          parsed.protocol === "postgresql:") &&
        parsed.hostname.length > 0
      );
    } catch {
      return false;
    }
  }, "Must be a valid PostgreSQL URL");

const modelId = z
  .string()
  .trim()
  .regex(/^[^\s/]+\/[^\s]+$/, "Must be an OpenRouter provider/model ID");

const cookieName = z
  .string()
  .trim()
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "Must be a valid cookie name");

const storagePath = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), "Must not contain a null byte");

const queueName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,127}$/,
    "Must be a lowercase queue name of at most 128 characters",
  );

function isLoopbackAppUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.preprocess(blankToUndefined, postgresUrl.optional()),
    SESSION_SECRET: optionalTrimmedString(z.string().min(32)),
    BOOTSTRAP_ADMIN_EMAIL: optionalTrimmedString(z.string().email()),
    BOOTSTRAP_ADMIN_PASSWORD: optionalTrimmedString(z.string().min(12)),
    OPENROUTER_API_KEY: optionalTrimmedString(z.string().min(1)),
    EXA_API_KEY: optionalTrimmedString(z.string().min(1)),
    SAM_API_KEY: optionalTrimmedString(z.string().min(1)),
    OPENROUTER_MODEL_FAST: modelId.default("openai/gpt-5.4-mini"),
    OPENROUTER_MODEL_DEEP: modelId.default("anthropic/claude-sonnet-5"),
    OPENROUTER_MODEL_FALLBACK: modelId.default("google/gemini-3.7-flash"),
    OPENROUTER_MAX_COST_PER_RUN_USD: positiveNumberWithDefault(2),
    OPENROUTER_MAX_COST_PER_DAY_USD: positiveNumberWithDefault(15),
    RESEARCH_MAX_TOOL_CALLS: positiveIntegerWithDefault(50, 10_000),
    RESEARCH_CONCURRENCY: positiveIntegerWithDefault(5, 100),
    PORT: positiveIntegerWithDefault(3_000, 65_535),
    APP_URL: z.string().trim().url().default("http://localhost:3000"),
    STORAGE_PATH: storagePath.default("./storage"),
    SESSION_COOKIE_NAME: cookieName.default("asi_session"),
    SESSION_COOKIE_SECURE: optionalBoolean,
    RESEARCH_QUEUE_NAME: queueName.default("research-jobs"),
    RESEARCH_SHARED_STORAGE: optionalBoolean,
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "test") {
      if (env.DATABASE_URL === undefined) {
        context.addIssue({
          code: "custom",
          message: "DATABASE_URL is required outside tests",
          path: ["DATABASE_URL"],
        });
      }

      if (env.SESSION_SECRET === undefined) {
        context.addIssue({
          code: "custom",
          message: "SESSION_SECRET is required outside tests",
          path: ["SESSION_SECRET"],
        });
      }
    }

    if (env.NODE_ENV === "development" && !isLoopbackAppUrl(env.APP_URL)) {
      context.addIssue({
        code: "custom",
        message:
          "NODE_ENV must be production when APP_URL is not a loopback URL",
        path: ["NODE_ENV"],
      });
    }

    const hasBootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL !== undefined;
    const hasBootstrapPassword = env.BOOTSTRAP_ADMIN_PASSWORD !== undefined;

    if (hasBootstrapEmail !== hasBootstrapPassword) {
      context.addIssue({
        code: "custom",
        message:
          "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be provided together",
        path: [
          hasBootstrapEmail
            ? "BOOTSTRAP_ADMIN_PASSWORD"
            : "BOOTSTRAP_ADMIN_EMAIL",
        ],
      });
    }
  })
  .transform((env) => ({
    ...env,
    SESSION_COOKIE_SECURE:
      env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === "production",
  }));

const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().trim().url().default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function getServerEnv(source?: EnvSource): ServerEnv {
  return serverEnvSchema.parse(source ?? process.env);
}

export function getPublicEnv(source?: EnvSource): PublicEnv {
  return publicEnvSchema.parse(
    source ?? {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    },
  );
}

export function allowsResearchDocumentWrites(env: ServerEnv): boolean {
  return env.RESEARCH_SHARED_STORAGE === true;
}
