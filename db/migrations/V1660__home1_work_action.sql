-- Authored by hand (not generated): what a person did about an item of the alert centre "Cần xử lý ngay" (HOME, ST-HOME-004, HOME-02 and the bell): they took it up, gave it to someone with a day, or put it off to a later time.
-- HOME keeps no state of the work of the modules: the items are read from the tables of the modules. This table keeps only the decisions of people about an item, one row for each decision, never changed and never removed, so that the
-- history of who took what up and who gave it to whom is whole (the audit trail and the outbox of the command say the same in their own tables). The latest row of each kind decides what the list shows.
-- `source` names the module the item comes from and `source_id` the item in it (a uuid, or the key of a cause that the list folds many records into, such as the diaries of a month that are missing), so the table never points at a
-- table of a module and an item that goes away (it was handled in its module) leaves its history behind.

CREATE TABLE machvon.work_action (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('APPROVAL', 'EXPLANATION', 'EXPLANATION_CONCLUDE', 'REPORT', 'OBLIGATION', 'EARLY_WARNING', 'ADVANCE', 'PERMIT', 'AUDIT_RECOMMENDATION', 'ISSUE', 'SITE_DIARY', 'GUARANTEE')),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 64),
  action text NOT NULL CHECK (action IN ('CLAIM', 'ASSIGN', 'SNOOZE')),
  actor_membership_id uuid NOT NULL,
  assignee_membership_id uuid,
  due_on date,
  snooze_until timestamptz,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, assignee_membership_id) REFERENCES machvon.membership (tenant_id, id),
  -- Each kind of decision says what it needs and nothing else: a claim has no operand, an assignment names who and may give a day, a postponement says until when.
  CONSTRAINT work_action_shape_chk CHECK (
    (action = 'CLAIM' AND assignee_membership_id IS NULL AND due_on IS NULL AND snooze_until IS NULL)
    OR (action = 'ASSIGN' AND assignee_membership_id IS NOT NULL AND snooze_until IS NULL)
    OR (action = 'SNOOZE' AND assignee_membership_id IS NULL AND due_on IS NULL AND snooze_until IS NOT NULL)
  )
);

CREATE INDEX work_action_item_idx ON machvon.work_action (tenant_id, source_id, source, created_at DESC, id);
CREATE INDEX work_action_actor_idx ON machvon.work_action (tenant_id, actor_membership_id, created_at DESC);
CREATE INDEX work_action_assignee_idx ON machvon.work_action (tenant_id, assignee_membership_id, created_at DESC) WHERE assignee_membership_id IS NOT NULL;

ALTER TABLE machvon.work_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.work_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.work_action AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.work_action AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only for the application: a decision is added, never edited or taken back (a later decision of the same kind replaces it in what the list shows).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.work_action FROM machvon_app;

COMMENT ON TABLE machvon.work_action IS 'Decisions of people about items of the alert centre (claim, assign, snooze); append-only, the latest of each kind decides what the list shows.';
