-- ENT-3b: the structured narrative of a period for the enterprise forms (HSKT DL.01, CN.02, CN.03; eng review R27).
--
-- It is not a second table. `report_narrative` already holds the words of a report revision (one row per project and period, written only while the report is a live DRAFT, fixed once it is handed in). It
-- gets one block per edition pack:
--   * `pack_code` / `pack_version` name the pack and the version of its block (the enterprise pack is `ENTERPRISE`, version 1); a row of the public edition has none of the pack columns;
--   * `pack_fields` holds the words of the pack as one object (the eight fields of the enterprise pack: status, schedule, disbursement, causes, difficulties, solutions, next_plan, proposals; a field
--     nobody wrote is not in the object);
--   * `cause_codes` are the standard causes picked from the list (MDM-17, the issue category list), `directive_refs` the directives of the leadership meetings that were rolled up, each with its state on
--     the last day of the period;
--   * the trace of an inheritance: when the words began as a copy of the previous period, which report they came from, when, by whom, and the hash of each copied field, so a reader can tell the words
--     that were kept from the ones that were rewritten. The trace is written by the command that copies, never by a request body.
-- The public columns stay as they were; the rule that a row is not empty now also counts a pack block with something in it.

ALTER TABLE machvon.report_narrative
  ADD COLUMN pack_code text,
  ADD COLUMN pack_version smallint,
  ADD COLUMN pack_fields jsonb,
  ADD COLUMN cause_codes text[],
  ADD COLUMN directive_refs jsonb,
  ADD COLUMN inherited_from_report_id uuid,
  ADD COLUMN inherited_at timestamptz,
  ADD COLUMN inherited_by uuid,
  ADD COLUMN inherited_hashes jsonb;

ALTER TABLE machvon.report_narrative
  ADD CONSTRAINT report_narrative_pack_chk CHECK (
    (pack_code IS NULL AND pack_version IS NULL AND pack_fields IS NULL AND cause_codes IS NULL AND directive_refs IS NULL)
    OR (
      pack_code ~ '^[A-Z][A-Z0-9_]{1,31}$'
      AND pack_version >= 1
      AND jsonb_typeof(pack_fields) = 'object'
      AND pg_column_size(pack_fields) <= 65536
      AND cause_codes IS NOT NULL AND cardinality(cause_codes) <= 20
      AND jsonb_typeof(directive_refs) = 'array' AND jsonb_array_length(directive_refs) <= 50
    )
  ),
  ADD CONSTRAINT report_narrative_enterprise_fields_chk CHECK (
    pack_code IS DISTINCT FROM 'ENTERPRISE'
    OR (pack_fields - ARRAY['status', 'schedule', 'disbursement', 'causes', 'difficulties', 'solutions', 'next_plan', 'proposals']) = '{}'::jsonb
  ),
  ADD CONSTRAINT report_narrative_inherited_chk CHECK (
    (inherited_from_report_id IS NULL AND inherited_at IS NULL AND inherited_by IS NULL AND inherited_hashes IS NULL)
    OR (
      inherited_from_report_id IS NOT NULL AND inherited_at IS NOT NULL AND inherited_by IS NOT NULL
      AND pack_code IS NOT NULL
      AND jsonb_typeof(inherited_hashes) = 'object'
      AND inherited_from_report_id <> report_revision_id
    )
  ),
  ADD CONSTRAINT report_narrative_inherited_from_fk FOREIGN KEY (tenant_id, inherited_from_report_id) REFERENCES machvon.report_revision (tenant_id, id);

CREATE INDEX report_narrative_inherited_from_idx ON machvon.report_narrative (tenant_id, inherited_from_report_id);
CREATE INDEX report_narrative_pack_idx ON machvon.report_narrative (tenant_id, pack_code, report_revision_id);

-- A narrative with nothing in it is not kept: words in a public section, an issue, or a pack block with a word, a cause or a directive.
ALTER TABLE machvon.report_narrative DROP CONSTRAINT report_narrative_not_empty_chk;
ALTER TABLE machvon.report_narrative
  ADD CONSTRAINT report_narrative_not_empty_chk CHECK (
    results_text IS NOT NULL OR causes_text IS NOT NULL OR solutions_text IS NOT NULL OR proposals_text IS NOT NULL OR coalesce(cardinality(linked_issue_ids), 0) > 0
    OR (pack_code IS NOT NULL AND (pack_fields <> '{}'::jsonb OR cardinality(cause_codes) > 0 OR jsonb_array_length(directive_refs) > 0))
  );
