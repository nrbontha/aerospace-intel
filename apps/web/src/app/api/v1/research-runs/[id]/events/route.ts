import { uuidSchema } from "@asi/contracts";
import { getResearchRunRecord } from "@asi/database";
import type { NextRequest } from "next/server";

import { jsonError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { AuthorizationError } from "@/lib/rbac";

const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

type RouteContext = { params: Promise<{ id: string }> };
type ResearchRunRecord = NonNullable<
  Awaited<ReturnType<typeof getResearchRunRecord>>
>;

function publicSnapshot(run: ResearchRunRecord) {
  const error =
    run.error === undefined
      ? undefined
      : {
          code: run.error.code,
          message: run.error.message,
        };

  return {
    id: run.id,
    status: run.status,
    progress: run.progress,
    progressPercent: run.progress * 100,
    actualCostUsd: run.actualCostUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    proposalCount: run.proposalCount,
    pendingProposalCount: run.pendingProposalCount,
    acceptedProposalCount: run.acceptedProposalCount,
    rejectedProposalCount: run.rejectedProposalCount,
    documentCount: run.documentCount,
    error,
    updatedAt:
      run.updatedAt instanceof Date
        ? run.updatedAt.toISOString()
        : run.updatedAt,
  };
}

function waitForPoll(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, POLL_INTERVAL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  try {
    await requireUser();

    const id = uuidSchema.safeParse((await context.params).id);
    if (!id.success) {
      return jsonError("validation_failed", "Invalid research run id", 400);
    }

    const initialRun = await getResearchRunRecord(id.data);
    if (initialRun === null) {
      return jsonError("not_found", "Research run not found", 404);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let run: ResearchRunRecord | null = initialRun;
        let lastSnapshot = "";
        let lastHeartbeatAt = Date.now();

        try {
          while (!request.signal.aborted && run !== null) {
            const snapshot = publicSnapshot(run);
            const serialized = JSON.stringify(snapshot);
            if (serialized !== lastSnapshot) {
              controller.enqueue(
                encoder.encode(`event: snapshot\ndata: ${serialized}\n\n`),
              );
              lastSnapshot = serialized;
            }

            if (TERMINAL_STATUSES.has(run.status)) break;
            if (!(await waitForPoll(request.signal))) break;

            const now = Date.now();
            if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              lastHeartbeatAt = now;
            }

            run = await getResearchRunRecord(id.data);
          }
        } catch {
          if (!request.signal.aborted) {
            controller.enqueue(
              encoder.encode(
                'event: error\ndata: {"error":{"code":"stream_failed","message":"Research status is temporarily unavailable"}}\n\n',
              ),
            );
          }
        } finally {
          try {
            controller.close();
          } catch {
            // The client may already have cancelled the stream.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return jsonError(
        error.status === 401 ? "unauthorized" : "forbidden",
        error.message,
        error.status,
      );
    }
    return jsonError("internal_error", "An internal error occurred", 500);
  }
}
