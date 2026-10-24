-- Authored by hand (not generated): the dataset catalogue with a distinct owner and steward (ST-DGV-001, DGV 3.1 F1).
-- The table, its row-level security (tenant_boundary and tenant_access) and the owner/steward CHECK come from V002; this adds what the
-- catalogue needs to be safe to read and to keep.

-- Who may see a dataset beyond the default of its classification (BR-DGV-11): a non-empty list narrows the dataset to the holders of one
-- of these roles, an empty list leaves the default (PUBLIC and INTERNAL are open to every catalogue reader, the other classes only to the
-- owner, the steward and the registrant). The owner, the steward and the registrant always see their own dataset.
ALTER TABLE machvon.dataset ADD COLUMN allowed_role_codes text[] NOT NULL DEFAULT '{}';

-- An owner and a steward are people of the tenant: a dataset cannot point at a member of another tenant or at a membership that does not exist.
ALTER TABLE machvon.dataset
  ADD CONSTRAINT dataset_owner_membership_fk FOREIGN KEY (tenant_id, owner_user_id) REFERENCES machvon.membership (tenant_id, id),
  ADD CONSTRAINT dataset_steward_membership_fk FOREIGN KEY (tenant_id, steward_user_id) REFERENCES machvon.membership (tenant_id, id);

-- DS-TREASURY and ds-treasury are the same dataset to a person: the code is unique without regard to case.
CREATE UNIQUE INDEX dataset_code_ci_uq ON machvon.dataset (tenant_id, lower(dataset_code));

-- Contracts, quality runs, lineage and BI datasets refer to a dataset and the audit trail names it: a dataset is retired, never deleted.
REVOKE DELETE, TRUNCATE ON TABLE machvon.dataset FROM machvon_app;
