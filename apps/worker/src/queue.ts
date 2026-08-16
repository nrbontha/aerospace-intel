import {
  type researchJobNameValues,
  researchJobPayloadSchema,
  type ResearchJobPayload,
} from "@asi/research";
import { PgBoss, type Job, type JobResult } from "pg-boss";

export type ResearchJobName = (typeof researchJobNameValues)[number];

export interface ResearchJobContext {
  jobId: string;
  signal: AbortSignal;
}

export type ResearchJobHandler<Name extends ResearchJobName> = (
  payload: Extract<ResearchJobPayload, { name: Name }>,
  context: ResearchJobContext,
) => Promise<void>;

export type ResearchJobHandlerRegistry = Partial<{
  [Name in ResearchJobName]: ResearchJobHandler<Name>;
}>;

export type QueueLogLevel = "error" | "info" | "warn";
export type QueueLogger = (
  level: QueueLogLevel,
  event: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

export interface WorkerQueueOptions {
  concurrency: number;
  databaseUrl: string;
  handlers: ResearchJobHandlerRegistry;
  logger: QueueLogger;
  queueName: string;
}

export interface WorkerQueue {
  isReady(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type DispatchHandler = (
  payload: ResearchJobPayload,
  context: ResearchJobContext,
) => Promise<void>;

const MAX_LOCAL_CONCURRENCY = 100;

export function createWorkerQueue(options: WorkerQueueOptions): WorkerQueue {
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > MAX_LOCAL_CONCURRENCY
  ) {
    throw new RangeError(
      `Worker concurrency must be an integer between 1 and ${MAX_LOCAL_CONCURRENCY}`,
    );
  }

  const boss = new PgBoss({
    application_name: "asi-worker",
    connectionString: options.databaseUrl,
  });

  let bossStarted = false;
  let ready = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  boss.on("error", (error) => {
    ready = false;
    options.logger("error", "queue.internal_error", {
      error: {
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined,
        name: error instanceof Error ? error.name : "UnknownError",
      },
    });
  });
  boss.on("warning", () => {
    options.logger("warn", "queue.warning");
  });
  boss.on("stopped", () => {
    ready = false;
  });

  const dispatchJob = async (job: Job<unknown>): Promise<JobResult> => {
    const parsed = researchJobPayloadSchema.safeParse(job.data);

    if (!parsed.success) {
      options.logger("warn", "queue.job_rejected", {
        jobId: job.id,
        reason: "invalid_payload",
      });
      return {
        id: job.id,
        output: { code: "INVALID_RESEARCH_JOB" },
        status: "deadletter",
      };
    }

    const payload = parsed.data;
    const handler = options.handlers[payload.name] as
      DispatchHandler | undefined;

    if (handler === undefined) {
      options.logger("warn", "queue.job_rejected", {
        jobId: job.id,
        jobName: payload.name,
        reason: "handler_not_registered",
      });
      return {
        id: job.id,
        output: { code: "RESEARCH_HANDLER_NOT_REGISTERED" },
        status: "deadletter",
      };
    }

    options.logger("info", "queue.job_started", {
      jobId: job.id,
      jobName: payload.name,
    });

    try {
      await handler(payload, { jobId: job.id, signal: job.signal });
      options.logger("info", "queue.job_completed", {
        jobId: job.id,
        jobName: payload.name,
      });
      return { id: job.id, status: "completed" };
    } catch (error) {
      options.logger("error", "queue.job_failed", {
        error: {
          code:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : undefined,
          name: error instanceof Error ? error.name : "UnknownError",
        },
        jobId: job.id,
        jobName: payload.name,
      });
      return {
        id: job.id,
        output: { code: "RESEARCH_HANDLER_FAILED" },
        status: "failed",
      };
    }
  };

  return {
    isReady(): boolean {
      return ready;
    },

    start(): Promise<void> {
      if (stopPromise !== undefined) {
        return Promise.reject(new Error("Cannot start a stopped worker queue"));
      }

      startPromise ??= (async () => {
        try {
          await boss.start();
          bossStarted = true;
          await boss.createQueue(options.queueName);
          await boss.work<unknown>(
            options.queueName,
            {
              batchSize: 1,
              localConcurrency: options.concurrency,
              perJobResults: true,
            },
            async (jobs) => Promise.all(jobs.map(dispatchJob)),
          );
          ready = true;
          options.logger("info", "queue.started", {
            concurrency: options.concurrency,
            queueName: options.queueName,
          });
        } catch (error) {
          ready = false;
          if (bossStarted) {
            bossStarted = false;
            await boss.stop({ close: true, graceful: true, timeout: 30_000 });
          }
          throw error;
        }
      })();

      return startPromise;
    },

    stop(): Promise<void> {
      ready = false;
      stopPromise ??= (async () => {
        if (startPromise !== undefined) {
          try {
            await startPromise;
          } catch {
            return;
          }
        }

        if (bossStarted) {
          bossStarted = false;
          await boss.stop({ close: true, graceful: true, timeout: 30_000 });
          options.logger("info", "queue.stopped");
        }
      })();

      return stopPromise;
    },
  };
}
