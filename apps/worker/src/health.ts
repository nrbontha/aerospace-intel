import { createServer, type Server, type ServerResponse } from "node:http";

import { getPool } from "@asi/database/client";

const DATABASE_PROBE_TIMEOUT_MS = 2_000;

export interface ReadinessState {
  isQueueReady(): boolean;
}

export interface HealthServer {
  stop(): Promise<void>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  includeBody: boolean,
): void {
  const payload = JSON.stringify(body);

  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(includeBody ? payload : undefined);
}

async function isDatabaseReady(): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    const query = getPool()
      .query("select 1")
      .then(
        () => true,
        () => false,
      );
    const { promise: timeoutResult, resolve: resolveTimeout } =
      Promise.withResolvers<boolean>();
    timeout = setTimeout(
      () => resolveTimeout(false),
      DATABASE_PROBE_TIMEOUT_MS,
    );
    timeout.unref();

    return await Promise.race([query, timeoutResult]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function listen(server: Server, port: number): Promise<void> {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  const onError = (error: Error): void => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = (): void => {
    server.off("error", onError);
    resolve();
  };

  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "0.0.0.0");
  return promise;
}

function close(server: Server): Promise<void> {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  server.close((error) => {
    if (error !== undefined) {
      reject(error);
      return;
    }

    resolve();
  });
  server.closeIdleConnections();
  return promise;
}

export async function startHealthServer(
  port: number,
  readiness: ReadinessState,
): Promise<HealthServer> {
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const includeBody = method !== "HEAD";

    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { status: "method_not_allowed" }, includeBody);
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://health.local")
      .pathname;

    if (pathname === "/health") {
      sendJson(response, 200, { status: "ok" }, includeBody);
      return;
    }

    if (pathname === "/ready") {
      const queueReady = readiness.isQueueReady();
      const databaseReady = queueReady && (await isDatabaseReady());
      const ready = queueReady && databaseReady;

      sendJson(
        response,
        ready ? 200 : 503,
        {
          checks: {
            database: databaseReady ? "ready" : "not_ready",
            queue: queueReady ? "ready" : "not_ready",
          },
          status: ready ? "ready" : "not_ready",
        },
        includeBody,
      );
      return;
    }

    sendJson(response, 404, { status: "not_found" }, includeBody);
  });

  await listen(server, port);

  let stopping: Promise<void> | undefined;

  return {
    stop(): Promise<void> {
      stopping ??= close(server);
      return stopping;
    },
  };
}
