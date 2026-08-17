import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";

import { getDatabase, getPool } from "./client.js";
import { imports, sourceDocuments } from "./schema.js";

export interface QueueJobCounts {
  readonly created: number;
  readonly retry: number;
  readonly active: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly failed: number;
}

export interface StoredDocumentRecord {
  readonly id: string;
  readonly storageKey: string;
  readonly contentSha256: string | null;
  readonly byteLength: number | null;
}

export interface StorageReconcileFinding {
  readonly kind: "missing_file" | "orphan_file" | "digest_mismatch" | "size_mismatch";
  readonly storageKey: string;
  readonly documentId?: string;
  readonly expected?: string;
  readonly observed?: string;
}

export interface StorageReconcileResult {
  readonly documentCount: number;
  readonly fileCount: number;
  readonly findings: readonly StorageReconcileFinding[];
}

export interface OperationsAlert {
  readonly severity: "warning" | "danger";
  readonly code: string;
  readonly message: string;
}

export interface OperationsSnapshot {
  readonly queue: QueueJobCounts;
  readonly drainable: boolean;
  readonly storage: StorageReconcileResult;
  readonly alerts: readonly OperationsAlert[];
}

export function buildOperationsAlerts(input: {
  readonly queue: QueueJobCounts;
  readonly drainable: boolean;
  readonly storage: StorageReconcileResult;
}): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  if (input.queue.failed > 0) {
    alerts.push({
      severity: "danger",
      code: "queue_failed",
      message: `${input.queue.failed} failed job(s) remain in pgboss.job`,
    });
  }
  if (!input.drainable) {
    alerts.push({
      severity: "warning",
      code: "queue_not_drainable",
      message: `${input.queue.created + input.queue.retry + input.queue.active} job(s) are still created, retrying, or active`,
    });
  }
  const missing = input.storage.findings.filter(
    (finding) => finding.kind === "missing_file",
  ).length;
  const digest = input.storage.findings.filter(
    (finding) => finding.kind === "digest_mismatch",
  ).length;
  const size = input.storage.findings.filter(
    (finding) => finding.kind === "size_mismatch",
  ).length;
  const orphan = input.storage.findings.filter(
    (finding) => finding.kind === "orphan_file",
  ).length;
  if (missing > 0 || digest > 0 || size > 0) {
    alerts.push({
      severity: "danger",
      code: "storage_inconsistent",
      message: `Storage reconciliation found ${missing} missing, ${digest} digest mismatch, and ${size} size mismatch`,
    });
  }
  if (orphan > 0) {
    alerts.push({
      severity: "warning",
      code: "storage_orphans",
      message: `${orphan} file(s) on disk have no source_documents locator`,
    });
  }
  return alerts;
}

const EMPTY_QUEUE: QueueJobCounts = {
  created: 0,
  retry: 0,
  active: 0,
  completed: 0,
  cancelled: 0,
  failed: 0,
};

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function diffStoredDocuments(input: {
  readonly documents: readonly StoredDocumentRecord[];
  readonly files: readonly {
    readonly storageKey: string;
    readonly sha256?: string;
    readonly byteLength?: number;
  }[];
}): StorageReconcileResult {
  const filesByKey = new Map(
    input.files.map((file) => [file.storageKey.replace(/^\/+/, ""), file]),
  );
  const findings: StorageReconcileFinding[] = [];

  for (const document of input.documents) {
    const key = document.storageKey.replace(/^\/+/, "");
    const file = filesByKey.get(key);
    if (file === undefined) {
      findings.push({
        kind: "missing_file",
        storageKey: key,
        documentId: document.id,
      });
      continue;
    }
    if (
      document.contentSha256 &&
      file.sha256 &&
      document.contentSha256.toLowerCase() !== file.sha256.toLowerCase()
    ) {
      findings.push({
        kind: "digest_mismatch",
        storageKey: key,
        documentId: document.id,
        expected: document.contentSha256.toLowerCase(),
        observed: file.sha256.toLowerCase(),
      });
    }
    if (
      document.byteLength !== null &&
      file.byteLength !== undefined &&
      document.byteLength !== file.byteLength
    ) {
      findings.push({
        kind: "size_mismatch",
        storageKey: key,
        documentId: document.id,
        expected: String(document.byteLength),
        observed: String(file.byteLength),
      });
    }
  }

  const knownKeys = new Set(
    input.documents.map((document) => document.storageKey.replace(/^\/+/, "")),
  );
  for (const file of input.files) {
    const key = file.storageKey.replace(/^\/+/, "");
    if (!knownKeys.has(key)) {
      findings.push({ kind: "orphan_file", storageKey: key });
    }
  }

  return {
    documentCount: input.documents.length,
    fileCount: input.files.length,
    findings,
  };
}

export async function getQueueJobCounts(): Promise<QueueJobCounts> {
  try {
    const result = await getPool().query<{ state: string; count: string }>(
      `select state, count(*)::text as count
       from pgboss.job
       group by state`,
    );
    const counts = {
      created: 0,
      retry: 0,
      active: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
    };
    for (const row of result.rows) {
      if (row.state in counts) {
        counts[row.state as keyof typeof counts] = n(row.count);
      }
    }
    return counts;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "42P01") {
      return EMPTY_QUEUE;
    }
    throw error;
  }
}

async function listStorageFiles(
  storagePath: string,
): Promise<{ storageKey: string; sha256: string; byteLength: number }[]> {
  const files: { storageKey: string; sha256: string; byteLength: number }[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      if (code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const contents = await readFile(fullPath);
      const info = await stat(fullPath);
      files.push({
        storageKey: path.relative(storagePath, fullPath).split(path.sep).join("/"),
        sha256: createHash("sha256").update(contents).digest("hex"),
        byteLength: info.size,
      });
    }
  }

  await walk(storagePath);
  return files;
}

export async function reconcileStoredDocuments(
  storagePath: string,
): Promise<StorageReconcileResult> {
  const db = getDatabase();
  const [documents, importRows] = await Promise.all([
    db
      .select({
        id: sourceDocuments.id,
        storageKey: sourceDocuments.storageKey,
        contentSha256: sourceDocuments.contentSha256,
        byteLength: sourceDocuments.byteLength,
      })
      .from(sourceDocuments)
      .where(sql`${sourceDocuments.storageKey} is not null`),
    db
      .select({
        id: imports.id,
        storageKey: imports.storageKey,
        contentSha256: imports.contentSha256,
      })
      .from(imports),
  ]);
  const files = await listStorageFiles(storagePath);
  return diffStoredDocuments({
    documents: [
      ...documents.flatMap((document) =>
        document.storageKey
          ? [
              {
                id: document.id,
                storageKey: document.storageKey,
                contentSha256: document.contentSha256,
                byteLength: document.byteLength,
              },
            ]
          : [],
      ),
      ...importRows.map((row) => ({
        id: row.id,
        storageKey: row.storageKey,
        contentSha256: row.contentSha256,
        byteLength: null,
      })),
    ],
    files,
  });
}

export async function getOperationsSnapshot(
  storagePath: string,
): Promise<OperationsSnapshot> {
  const [queue, storage] = await Promise.all([
    getQueueJobCounts(),
    reconcileStoredDocuments(storagePath),
  ]);
  const drainable = queue.created + queue.retry + queue.active === 0;
  return {
    queue,
    drainable,
    storage,
    alerts: buildOperationsAlerts({ queue, drainable, storage }),
  };
}
