-- Authored by hand (not generated): the binding of a glossary term to a dataset or one of its columns (ST-DGV-007, DGV 3.1, DGV-02).
-- V002 gave `dataset_glossary_binding` its columns, the keys to the dataset and to the term, and a unique index that cannot stop a binding of the dataset as a whole from being written twice (a NULL column differs from
-- every other NULL). DGV holds no table of terms: a binding points at one revision of a term of MDM, which must be PUBLISHED when it is bound, and the term stays where it is. This replaces that index with one that
-- treats the dataset as a whole as a column of its own, checks the shape of the column name, adds the read by dataset, and makes the table append-only for the application (a binding is replaced by binding a newer
-- revision of the term, never edited or deleted).

ALTER TABLE machvon.dataset_glossary_binding
  ADD CONSTRAINT dataset_glossary_binding_column_chk CHECK (column_name IS NULL OR (column_name = btrim(column_name) AND char_length(column_name) BETWEEN 1 AND 120));

DROP INDEX machvon.dataset_glossary_binding_bind_uq;
CREATE UNIQUE INDEX dataset_glossary_binding_uq ON machvon.dataset_glossary_binding (tenant_id, dataset_id, glossary_term_id, COALESCE(column_name, ''));
CREATE INDEX dataset_glossary_binding_list_idx ON machvon.dataset_glossary_binding (tenant_id, dataset_id, bound_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.dataset_glossary_binding FROM machvon_app;
