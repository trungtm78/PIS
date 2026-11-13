-- Authored by hand (not generated): the revision of the form an evidence was made from, and how the kind of workflow of a project was chosen (PWF-4, docs PWF R46, R47).
-- Expand step of an expand-contract change: every column is nullable and nothing reads it as required, so the code before this migration and the rows written before it stay valid. No contract step is planned: the columns stay nullable
-- for evidence that names no form and for workflows started before the rule that maps a project to its kind of workflow existed.

-- R46: a form is used at the revision that is approved on the day it is used (or the one the template pins); the evidence keeps that revision and the hash of its content, so that what a document was made from can be found again
-- after the form has a newer revision. NULL: the evidence names no form, or it names a form the document store of the tenant has no approved revision of (rows written before this migration).
ALTER TABLE machvon.project_task_evidence
  ADD COLUMN form_template_revision integer,
  ADD COLUMN form_template_sha256 char(64),
  ADD CONSTRAINT project_task_evidence_form_revision_chk CHECK (
    (form_template_revision IS NULL AND form_template_sha256 IS NULL)
    OR (form_template_code IS NOT NULL AND form_template_revision IS NOT NULL AND form_template_sha256 IS NOT NULL AND form_template_revision > 0 AND form_template_sha256 ~ '^[0-9a-f]{64}$')
  );

-- R47: what the rule PROJECT_WORKFLOW_ASSIGNMENT suggested (template, basis, line, the rule and its version), what the person chose, how (AUTO, CONFIRMED, OVERRIDE, MANUAL) and why. NULL for a workflow started before the rule existed.
ALTER TABLE machvon.project_workflow
  ADD COLUMN selection jsonb,
  ADD CONSTRAINT project_workflow_selection_chk CHECK (selection IS NULL OR (jsonb_typeof(selection) = 'object' AND selection ->> 'mode' IN ('AUTO', 'CONFIRMED', 'OVERRIDE', 'MANUAL')));

-- R45: the codes of the legal documents (catalogue LEGAL_DOCUMENT) the frozen template of the workflow cites on its steps and tasks, written when the workflow is made. The alert of a legal ground that lapsed reads the running
-- workflows that cite a code through this column and its index, never the frozen JSON of every workflow (R35, bounded reads). NULL for a workflow made before legal grounds existed: its template cites nothing.
ALTER TABLE machvon.project_workflow ADD COLUMN cited_legal_documents text[];
CREATE INDEX project_workflow_cited_legal_idx ON machvon.project_workflow USING gin (cited_legal_documents) WHERE status = 'ACTIVE' AND cited_legal_documents IS NOT NULL;

COMMENT ON COLUMN machvon.project_task_evidence.form_template_revision IS 'The revision of the form template the evidence was made from (PWF-4, R46); NULL when the evidence names no form or the form had no approved revision.';
COMMENT ON COLUMN machvon.project_task_evidence.form_template_sha256 IS 'The content hash (document_template.content_sha256) of that revision, so the form can be told apart after it is revised (PWF-4, R46).';
COMMENT ON COLUMN machvon.project_workflow.cited_legal_documents IS 'The codes of the legal documents the frozen template cites (PWF-4, R45); read by the alert of a lapsed legal ground.';
COMMENT ON COLUMN machvon.project_workflow.selection IS 'How the template of the workflow was chosen: the suggestion of the rule PROJECT_WORKFLOW_ASSIGNMENT, the choice, the mode and the reason (PWF-4, R47).';
