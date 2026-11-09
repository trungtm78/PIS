-- Authored by hand (not generated): ENT-3e, the split between the resolution of the group and the decision of the company per project (CN.01, docs/fnd-funding-model.md).
-- The enterprise pack already lists the origins GROUP_ASSIGNED and BOARD_APPROVED (V2061). What was missing is the kind of the decision document that backs an appropriation: the resolution of PVN backs
-- GROUP_ASSIGNED, the decision of the company backs BOARD_APPROVED. The kind is a code of the legal-document catalogue of the edition (rule type ENT_LEGAL_DOC_TYPE) that the pack binds to the origin
-- (`origin_decisions` of FUNDING_TAXONOMY); the application judges it against the pack, the database only keeps the two sides apart: a public appropriation carries no kind, an enterprise one always carries one.
-- Expand only: the column is new and nullable, every existing row is PUBLIC with no kind, so the CHECK is satisfied by what is already there and a rollback of the code needs no rollback of the schema.

ALTER TABLE machvon.appropriation ADD COLUMN decision_kind text;

ALTER TABLE machvon.appropriation ADD CONSTRAINT appropriation_decision_kind_chk CHECK (
  (taxonomy_pack = 'PUBLIC' AND decision_kind IS NULL)
  OR (taxonomy_pack = 'ENTERPRISE' AND decision_kind IS NOT NULL AND decision_kind ~ '^[A-Z][A-Z0-9_]{1,39}$'));

COMMENT ON COLUMN machvon.appropriation.decision_kind IS 'ENT-3e: the kind of the decision document (a code of the legal-document catalogue) that backs the appropriation; null for the public pack, required for the enterprise pack, bound to the origin by the pack.';

-- The decision document behind each plan line of a project, by origin: one row per plan line, with the origin of the capital, the document that assigned it (symbol and day), its kind and the issuing authority. A reader
-- groups it by project, plan year and origin to show how much of the plan of a project came from the resolution of the group and how much from the decision of the company (the sum is the plan in force of the project).
CREATE VIEW machvon.v_project_origin_decision WITH (security_invoker = true) AS
SELECT
  al.tenant_id,
  al.project_id,
  al.id AS allocation_line_id,
  pv.id AS plan_version_id,
  pv.status AS plan_status,
  pv.fiscal_year AS plan_year,
  a.id AS appropriation_id,
  a.taxonomy_pack,
  a.origin,
  a.decision_kind,
  a.decision_document_id,
  d.symbol AS decision_symbol,
  d.issued_on AS decision_issued_on,
  a.issuing_authority,
  al.bucket,
  al.amount_vnd
FROM machvon.allocation_line al
JOIN machvon.plan_version pv ON pv.tenant_id = al.tenant_id AND pv.id = al.plan_version_id
JOIN machvon.appropriation a ON a.tenant_id = al.tenant_id AND a.id = al.appropriation_id
LEFT JOIN machvon.document d ON d.tenant_id = a.tenant_id AND d.id = a.decision_document_id;

COMMENT ON VIEW machvon.v_project_origin_decision IS 'ENT-3e: the plan lines of a project with the origin of their capital and the decision document that assigned it (the resolution of the group or the decision of the company in the enterprise pack).';
