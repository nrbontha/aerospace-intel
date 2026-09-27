import { sql } from "drizzle-orm";
import type { Database } from "@asi/database";

/**
 * Select-or-insert persistence for Exa-fetched evidence.
 *
 * Production schema has drifted from the Drizzle definitions: the
 * expression unique index backing `ON CONFLICT (lower(name), ...)` does
 * not exist in prod, so any raw `ON CONFLICT` on an expression fails with
 * "no unique or exclusion constraint". These helpers never use ON
 * CONFLICT: SELECT first, INSERT on miss, reselect on unique-violation
 * races. Single-worker ticks make races negligible; the reselect covers
 * them anyway.
 */

export async function resolveExaSourceId(
  db: Database,
  sourceType: string,
): Promise<string | null> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM data_sources WHERE lower(name) = 'exa' LIMIT 1
  `);
  const hit = existing.rows[0]?.id ?? null;
  if (hit !== null) return hit;
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO data_sources (name, source_type, publisher, access, ingestion)
      VALUES ('Exa', ${sourceType}, 'Exa', 'public', 'manual')
      RETURNING id
    `);
    const id = inserted.rows[0]?.id ?? null;
    if (id !== null) return id;
  } catch {
    // Unique-violation race: fall through to reselect.
  }
  const retry = await db.execute<{ id: string }>(sql`
    SELECT id FROM data_sources WHERE lower(name) = 'exa' LIMIT 1
  `);
  return retry.rows[0]?.id ?? null;
}

export async function resolveDocumentId(
  db: Database,
  args: {
    sourceId: string;
    url: string;
    title: string;
    documentType: string;
    contentHash: string;
    metadataJson: string;
  },
): Promise<string | null> {
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM source_documents WHERE content_sha256 = ${args.contentHash} LIMIT 1
  `);
  const hit = existing.rows[0]?.id ?? null;
  if (hit !== null) return hit;
  try {
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO source_documents
        (data_source_id, canonical_url, title, document_type, content_sha256, metadata)
      VALUES (
        ${args.sourceId},
        ${args.url},
        ${args.title},
        ${args.documentType},
        ${args.contentHash},
        ${args.metadataJson}::jsonb
      )
      RETURNING id
    `);
    const id = inserted.rows[0]?.id ?? null;
    if (id !== null) return id;
  } catch {
    // Unique-violation race: fall through to reselect.
  }
  const retry = await db.execute<{ id: string }>(sql`
    SELECT id FROM source_documents WHERE content_sha256 = ${args.contentHash} LIMIT 1
  `);
  return retry.rows[0]?.id ?? null;
}
