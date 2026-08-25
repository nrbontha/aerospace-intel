BEGIN;
-- Migration 0006: additive FAA PMA synthesis targets and identity safeguards.
-- Do not use the new enum value in this transaction; PostgreSQL exposes an
-- appended enum label only after the migration commits.
ALTER TYPE identifier_type ADD VALUE IF NOT EXISTS 'faa_pma_holder';

-- Public documents can now support a specific platform variant or a durable
-- facility qualification, while still linking to exactly one target.
ALTER TABLE source_document_links
  ADD COLUMN IF NOT EXISTS platform_variant_id uuid,
  ADD COLUMN IF NOT EXISTS facility_qualification_id uuid;

ALTER TABLE source_document_links
  ADD CONSTRAINT source_document_links_platform_variant_fk
    FOREIGN KEY (platform_variant_id) REFERENCES platform_variants(id) ON DELETE CASCADE,
  ADD CONSTRAINT source_document_links_facility_qualification_fk
    FOREIGN KEY (facility_qualification_id) REFERENCES facility_qualifications(id) ON DELETE CASCADE;

-- 0000 used an unnamed table CHECK; drop both its generated name and the
-- explicit schema name so this remains safe against either historical shape.
ALTER TABLE source_document_links
  DROP CONSTRAINT IF EXISTS source_document_links_check,
  DROP CONSTRAINT IF EXISTS source_document_links_target_chk;
ALTER TABLE source_document_links
  ADD CONSTRAINT source_document_links_target_chk CHECK (
    num_nonnulls(
      company_id,
      facility_id,
      part_id,
      platform_id,
      platform_variant_id,
      contract_id,
      facility_qualification_id
    ) = 1
  );

CREATE UNIQUE INDEX source_document_links_target_uidx
  ON source_document_links (
    source_document_id,
    relationship,
    coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(facility_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(part_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(platform_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(platform_variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(facility_qualification_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Imported qualifications are drafts until synthesis promotes them. A source
-- reference is authoritative within a facility; context uniqueness remains as
-- the fallback for qualifications without a reference.
ALTER TABLE facility_qualifications
  ADD COLUMN IF NOT EXISTS status record_status NOT NULL DEFAULT 'draft';

CREATE UNIQUE INDEX facility_qualifications_reference_uidx
  ON facility_qualifications (facility_id, qualification_reference)
  WHERE qualification_reference IS NOT NULL;

-- The composite FK deterministically rejects a variant paired with any other
-- platform. The existing CHECK still requires platform_id when a variant exists.
CREATE UNIQUE INDEX platform_variants_id_platform_uidx
  ON platform_variants (id, platform_id);
ALTER TABLE facility_qualifications
  ADD CONSTRAINT facility_qualifications_variant_platform_fk
  FOREIGN KEY (platform_variant_id, platform_id)
  REFERENCES platform_variants(id, platform_id)
  ON DELETE CASCADE;

-- Alternate identifiers are reusable across distinct parts, but not duplicated
-- within one part. Keep a broad lookup path for cross-part synthesis.
DROP INDEX IF EXISTS part_alternate_ids_natural_uidx;
CREATE UNIQUE INDEX part_alternate_ids_natural_uidx
  ON part_alternate_ids (
    part_id,
    identifier_type,
    upper(identifier_value),
    coalesce(authority, '')
  );
CREATE INDEX part_alternate_ids_lookup_idx
  ON part_alternate_ids (identifier_type, upper(identifier_value));

-- Only complete addresses participate: incomplete records remain importable,
-- while normalized complete FAA/SAM addresses cannot race for the same company.
CREATE UNIQUE INDEX facilities_complete_address_uidx
  ON facilities (
    company_id,
    upper(btrim(country_code)),
    lower(btrim(address_line_1)),
    lower(btrim(city)),
    lower(btrim(region)),
    lower(btrim(postal_code))
  )
  WHERE company_id IS NOT NULL
    AND nullif(btrim(country_code), '') IS NOT NULL
    AND nullif(btrim(address_line_1), '') IS NOT NULL
    AND nullif(btrim(city), '') IS NOT NULL
    AND nullif(btrim(region), '') IS NOT NULL
    AND nullif(btrim(postal_code), '') IS NOT NULL;

COMMIT;
