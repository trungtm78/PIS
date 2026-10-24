-- Authored by hand (not generated): the ranges of the rule data never overlap in the tables that did not yet say so (ST-KERNEL-060, NFR-LEGAL-02).
-- A rule that a law changes is a new version with its own effective range; the version that governed a date is found by the date, so two published versions of one rule
-- that both cover a day would make the answer depend on an order. document_template (V002), master_record_version, the SLA, the report forms and rules of MNE and the
-- permit tables already hold this with an exclusion constraint; the tables below held only a unique start date (or nothing). Draft and retired versions are not judged: a
-- draft is a proposal and may overlap what it will replace. The constraints are deferrable so that a command that retires one version and publishes the next in one
-- transaction is not judged between its two statements. The registry that says which table is judged how, and the lint that refuses a table that has a range and is not in
-- it, are packages/db/src/effective-range-registry.ts and packages/db/test/effective-range-lint.test.ts.

ALTER TABLE machvon.doc_type
  ADD CONSTRAINT doc_type_no_overlap EXCLUDE USING gist (tenant_id WITH =, code WITH =, daterange(effective_from, effective_until, '[)') WITH &&) WHERE (status = 'PUBLISHED') DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE machvon.doc_retention_rule
  ADD CONSTRAINT doc_retention_rule_no_overlap EXCLUDE USING gist (tenant_id WITH =, rule_set WITH =, category_code WITH =, daterange(effective_from, effective_until, '[)') WITH &&) WHERE (status = 'PUBLISHED') DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE machvon.document_layout_profile
  ADD CONSTRAINT document_layout_profile_no_overlap EXCLUDE USING gist (tenant_id WITH =, profile_code WITH =, daterange(effective_from, effective_until, '[)') WITH &&) WHERE (status = 'PUBLISHED') DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE machvon.early_warning_rule
  ADD CONSTRAINT early_warning_rule_no_overlap EXCLUDE USING gist (tenant_id WITH =, rule_code WITH =, daterange(effective_from, effective_until, '[)') WITH &&) WHERE (status = 'PUBLISHED') DEFERRABLE INITIALLY DEFERRED;

-- One delegation-of-authority matrix is in force at a time.
ALTER TABLE machvon.doa_matrix_version
  ADD CONSTRAINT doa_matrix_version_no_overlap EXCLUDE USING gist (tenant_id WITH =, daterange(effective_from, effective_until, '[)') WITH &&) WHERE (status = 'Published') DEFERRABLE INITIALLY DEFERRED;

-- A period that ends before it starts is never a period. These tables had no check of it (the exclusion constraints reject it for the rules that have one, but only as a side
-- effect of building the daterange); the lint of the registry asks every range for one.
ALTER TABLE machvon.early_warning_rule ADD CONSTRAINT early_warning_rule_range_chk CHECK (effective_until IS NULL OR effective_until > effective_from);
ALTER TABLE machvon.mne_obligation_rule ADD CONSTRAINT mne_rule_range_chk CHECK (effective_until IS NULL OR effective_until > effective_from);
ALTER TABLE machvon.contract_party ADD CONSTRAINT contract_party_period_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);
ALTER TABLE machvon.master_crosswalk ADD CONSTRAINT master_crosswalk_period_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);
ALTER TABLE machvon.membership ADD CONSTRAINT membership_period_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);
ALTER TABLE machvon.project_component ADD CONSTRAINT project_component_period_chk CHECK (valid_until IS NULL OR valid_until >= valid_from);
