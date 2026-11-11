-- Authored by hand (not generated): ENT-4a (docs/plans/ent4a.md). Two lookup columns of the cross-report comparison tables had no (tenant_id, column) index, which the RLS catalogue test requires for every *_id column
-- of a tenant table: the rule that an explanation answers (rule_id) and the draft that a release belongs to (draft_id). Expand only: indexes are added, nothing is changed or removed; idempotent.
CREATE INDEX IF NOT EXISTS report_crosscheck_explanation_rule_idx ON machvon.report_crosscheck_explanation (tenant_id, rule_id);
CREATE INDEX IF NOT EXISTS report_crosscheck_release_draft_idx ON machvon.report_crosscheck_release (tenant_id, draft_id);
