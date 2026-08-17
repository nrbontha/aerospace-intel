import { allowsResearchDocumentWrites, getServerEnv } from "@asi/config";
import { PgBoss } from "pg-boss";

const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;

export class ResearchQueueDisabledError extends Error {
  constructor() {
    super(
      "Research is disabled until shared document storage is configured",
    );
    this.name = "ResearchQueueDisabledError";
  }
}

export interface SourceResearchJobPayload {
  readonly name: "research.source.v1";
  readonly researchRunId: string;
  readonly requestedByUserId: string;
  readonly dataSourceId: string;
}

export interface CompanyResearchJobPayload {
  readonly name: "research.company.v1";
  readonly researchRunId: string;
  readonly requestedByUserId: string;
  readonly companyId: string;
}

export interface PlatformResearchJobPayload {
  readonly name: "research.platform.v1";
  readonly researchRunId: string;
  readonly requestedByUserId: string;
  readonly platformId: string;
}

export interface PartResearchJobPayload {
  readonly name: "research.part.v1";
  readonly researchRunId: string;
  readonly requestedByUserId: string;
  readonly partId: string;
}

export interface DiscoverResearchJobPayload {
  readonly name: "research.discover.v1";
  readonly researchRunId: string;
  readonly requestedByUserId: string;
  readonly objective: string;
  readonly targetTypes: readonly string[];
  readonly seedTerms?: readonly string[];
}

export interface RefreshResearchJobPayload {
  readonly name: "research.refresh.v1";
  readonly researchRunId: string;
  readonly requestedByUserId: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly staleBefore?: string;
}

type ResearchProducerPayload =
  | SourceResearchJobPayload
  | CompanyResearchJobPayload
  | PlatformResearchJobPayload
  | PartResearchJobPayload
  | DiscoverResearchJobPayload
  | RefreshResearchJobPayload;

interface ResearchQueueProducerState {
  boss?: PgBoss | undefined;
  startPromise?: Promise<PgBoss> | undefined;
  stopPromise?: Promise<void> | undefined;
  stopped: boolean;
  shutdownHookInstalled: boolean;
}

const queueGlobal = globalThis as typeof globalThis & {
  __asiResearchQueueProducer?: ResearchQueueProducerState;
};

const state =
  queueGlobal.__asiResearchQueueProducer ??
  (queueGlobal.__asiResearchQueueProducer = {
    shutdownHookInstalled: false,
    stopped: false,
  });

async function startProducer(): Promise<PgBoss> {
  if (state.stopped) {
    throw new Error("The research queue producer is shutting down");
  }

  if (state.startPromise === undefined) {
    const env = getServerEnv();
    if (env.DATABASE_URL === undefined) {
      throw new Error("DATABASE_URL is required to enqueue research");
    }

    const boss = new PgBoss({
      application_name: "asi-web",
      connectionString: env.DATABASE_URL,
    });
    state.boss = boss;

    // pg-boss emits operational errors through EventEmitter. The request that
    // performs queue I/O still receives its rejected promise; this listener
    // prevents an unhandled error event without exposing connection details.
    boss.on("error", () => undefined);

    const startPromise = (async () => {
      let started = false;
      try {
        await boss.start();
        started = true;
        await boss.createQueue(env.RESEARCH_QUEUE_NAME);

        if (state.stopped) {
          throw new Error("The research queue producer is shutting down");
        }

        return boss;
      } catch (error) {
        if (started) {
          await boss
            .stop({ close: true, graceful: true, timeout: 30_000 })
            .catch(() => undefined);
        }
        if (state.boss === boss) state.boss = undefined;
        throw error;
      }
    })();

    state.startPromise = startPromise;
    void startPromise.catch(() => {
      if (state.startPromise === startPromise && !state.stopped) {
        state.startPromise = undefined;
      }
    });
  }

  return state.startPromise;
}

async function enqueueResearchJob(
  payload: ResearchProducerPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  if (!allowsResearchDocumentWrites(getServerEnv())) {
    throw new ResearchQueueDisabledError();
  }

  const boss = await startProducer();
  if (state.stopped) {
    throw new Error("The research queue producer is shutting down");
  }

  const queueName = getServerEnv().RESEARCH_QUEUE_NAME;
  const jobId = await boss.send(queueName, payload, {
    singletonKey: `${payload.name}:${payload.researchRunId}`,
    singletonSeconds: IDEMPOTENCY_WINDOW_SECONDS,
  });

  return { jobId, duplicate: jobId === null };
}

export async function enqueueSourceResearchJob(
  payload: SourceResearchJobPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  return enqueueResearchJob(payload);
}

export async function enqueueCompanyResearchJob(
  payload: CompanyResearchJobPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  return enqueueResearchJob(payload);
}

export async function enqueuePlatformResearchJob(
  payload: PlatformResearchJobPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  return enqueueResearchJob(payload);
}

export async function enqueuePartResearchJob(
  payload: PartResearchJobPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  return enqueueResearchJob(payload);
}

export async function enqueueDiscoverResearchJob(
  payload: DiscoverResearchJobPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  return enqueueResearchJob(payload);
}

export async function enqueueRefreshResearchJob(
  payload: RefreshResearchJobPayload,
): Promise<{ jobId: string | null; duplicate: boolean }> {
  return enqueueResearchJob(payload);
}

export function shutdownResearchQueueProducer(): Promise<void> {
  state.stopped = true;
  state.stopPromise ??= (async () => {
    const startPromise = state.startPromise;
    if (startPromise !== undefined) {
      await startPromise.catch(() => undefined);
    }

    const boss = state.boss;
    state.boss = undefined;
    if (boss !== undefined) {
      await boss.stop({ close: true, graceful: true, timeout: 30_000 });
    }
  })();

  return state.stopPromise;
}

if (!state.shutdownHookInstalled) {
  state.shutdownHookInstalled = true;
  process.once("beforeExit", () => {
    void shutdownResearchQueueProducer();
  });
}
