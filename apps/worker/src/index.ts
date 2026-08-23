import { pathToFileURL } from "node:url";

import { allowsResearchDocumentWrites, getServerEnv } from "@asi/config";
import { closeDatabase } from "@asi/database/client";
import { OpenRouterClient } from "@asi/research";

import { startHealthServer, type HealthServer } from "./health.js";
import {
  createCampaignProcessHandler,
  createCandidateResearchHandler,
  createCompanyResearchHandler,
  createDiscoverResearchHandler,
  createLeadsIngestHandler,
  createPartResearchHandler,
  createPlatformResearchHandler,
  createRefreshResearchHandler,
  createSourceResearchHandler,
} from "./handlers/index.js";
import {
  createWorkerQueue,
  type QueueLogger,
  type ResearchJobHandlerRegistry,
  type WorkerQueue,
} from "./queue.js";

const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|credential|database.?url|password|secret|token|api.?key/i;
const POSTGRES_URL_PATTERN = /postgres(?:ql)?:\/\/[^\s"']+/giu;
const BEARER_PATTERN = /bearer\s+[^\s"']+/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s&,;]+/giu;

export interface WorkerRuntime {
  stop(): Promise<void>;
}

function redactText(value: string): string {
  return value
    .replaceAll(POSTGRES_URL_PATTERN, "[REDACTED_DATABASE_URL]")
    .replaceAll(BEARER_PATTERN, "Bearer [REDACTED]")
    .replaceAll(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]");
}

function redactValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (depth >= 6) {
    return "[TRUNCATED]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (value instanceof Error) {
    const errorCode =
      "code" in value && typeof value.code === "string"
        ? redactText(value.code)
        : undefined;
    return {
      code: errorCode,
      message: redactText(value.message),
      name: value.name,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, undefined, seen, depth + 1));
  }

  const redacted: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    redacted[entryKey] = redactValue(entryValue, entryKey, seen, depth + 1);
  }
  return redacted;
}

const log: QueueLogger = (level, event, fields = {}) => {
  const entry = redactValue(
    {
      event,
      level,
      service: "worker",
      timestamp: new Date().toISOString(),
      ...fields,
    },
    undefined,
    new WeakSet<object>(),
    0,
  );
  const serialized = JSON.stringify(entry);

  if (level === "error") {
    process.stderr.write(`${serialized}\n`);
    return;
  }

  process.stdout.write(`${serialized}\n`);
};

async function stopComponents(
  healthServer: HealthServer | undefined,
  queue: WorkerQueue | undefined,
): Promise<void> {
  const errors: unknown[] = [];

  try {
    await healthServer?.stop();
  } catch (error) {
    errors.push(error);
  }

  try {
    await queue?.stop();
  } catch (error) {
    errors.push(error);
  }

  try {
    await closeDatabase();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Worker shutdown failed");
  }
}

export async function startWorker(): Promise<WorkerRuntime> {
  const env = getServerEnv();
  if (!allowsResearchDocumentWrites(env)) {
    log("warn", "research.handlers.disabled", {
      reason: "shared_storage_required",
    });
    const healthServer = await startHealthServer(env.PORT, {
      isQueueReady: () => false,
    });
    log("info", "worker.started", {
      healthPort: env.PORT,
      researchHandlers: false,
    });
    let stopPromise: Promise<void> | undefined;
    return {
      stop(): Promise<void> {
        stopPromise ??= (async () => {
          log("info", "worker.stopping");
          await stopComponents(healthServer, undefined);
          log("info", "worker.stopped");
        })();
        return stopPromise;
      },
    };
  }

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is required to start the worker");
  }

  const openRouterApiKey = env.OPENROUTER_API_KEY;
  if (openRouterApiKey === undefined) {
    throw new Error("OPENROUTER_API_KEY is required to start the worker");
  }

  const openRouterClient = new OpenRouterClient(openRouterApiKey);
  const shared = {
    client: openRouterClient,
    logger: log,
    maxToolCalls: env.RESEARCH_MAX_TOOL_CALLS,
    models: {
      deep: env.OPENROUTER_MODEL_DEEP,
      fallback: env.OPENROUTER_MODEL_FALLBACK,
      fast: env.OPENROUTER_MODEL_FAST,
    },
  } as const;
  const handlers = Object.freeze({
    "leads.ingest.v1": createLeadsIngestHandler({ logger: log }),
    "campaign-process.v1": createCampaignProcessHandler({
      queueName: env.RESEARCH_QUEUE_NAME,
      logger: log,
    }),
    "research.company.v1": createCompanyResearchHandler({
      ...shared,
      maxCostPerDayUsd: env.OPENROUTER_MAX_COST_PER_DAY_USD,
      maxCostPerRunUsd: env.OPENROUTER_MAX_COST_PER_RUN_USD,
    }),
    "research.source.v1": createSourceResearchHandler({
      ...shared,
      maxCostPerDayUsd: env.OPENROUTER_MAX_COST_PER_DAY_USD,
      maxCostPerRunUsd: env.OPENROUTER_MAX_COST_PER_RUN_USD,
    }),
    "research.platform.v1": createPlatformResearchHandler(shared),
    "research.part.v1": createPartResearchHandler(shared),
    "research.discover.v1": createDiscoverResearchHandler(shared),
    "candidate-research.v1": createCandidateResearchHandler(shared),
    "research.refresh.v1": createRefreshResearchHandler(shared),
  }) satisfies ResearchJobHandlerRegistry;
  let healthServer: HealthServer | undefined;
  let queue: WorkerQueue | undefined;

  log("info", "worker.starting", {
    concurrency: env.RESEARCH_CONCURRENCY,
    healthPort: env.PORT,
    queueName: env.RESEARCH_QUEUE_NAME,
  });

  try {
    healthServer = await startHealthServer(env.PORT, {
      isQueueReady: () => queue?.isReady() ?? false,
    });
    queue = createWorkerQueue({
      concurrency: env.RESEARCH_CONCURRENCY,
      databaseUrl,
      handlers,
      logger: log,
      queueName: env.RESEARCH_QUEUE_NAME,
    });
    await queue.start();
  } catch (error) {
    try {
      await stopComponents(healthServer, queue);
    } catch (shutdownError) {
      log("error", "worker.startup_cleanup_failed", { error: shutdownError });
    }
    throw error;
  }

  log("info", "worker.started", {
    healthPort: env.PORT,
    queueName: env.RESEARCH_QUEUE_NAME,
  });

  let stopPromise: Promise<void> | undefined;
  return {
    stop(): Promise<void> {
      stopPromise ??= (async () => {
        log("info", "worker.stopping");
        await stopComponents(healthServer, queue);
        log("info", "worker.stopped");
      })();
      return stopPromise;
    },
  };
}

async function main(): Promise<void> {
  try {
    const runtime = await startWorker();
    let shutdownPromise: Promise<void> | undefined;

    const shutdown = (signal: NodeJS.Signals): void => {
      shutdownPromise ??= (async () => {
        log("info", "worker.signal_received", { signal });
        try {
          await runtime.stop();
        } catch (error) {
          process.exitCode = 1;
          log("error", "worker.shutdown_failed", { error });
        }
      })();
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    process.exitCode = 1;
    log("error", "worker.startup_failed", { error });
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await main();
}
