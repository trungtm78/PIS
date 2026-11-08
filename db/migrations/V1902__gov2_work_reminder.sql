-- Authored by hand (not generated): every reminder, and every notice to the next level, that the alert centre makes about an item (governance deepening, lane GOV-2, roadmap G2-4 and G2-1/G2-2). A reminder that is sent and not
-- recorded cannot be counted, capped or explained, so each one is a row here, appended and never changed, with the event of the outbox that carries it written in the same transaction.
-- `series_key` names the one reminder of a series (an item, a person, the number of the reminder): a pass that runs twice, or two processes that run it at once, record it once.
-- Recipients are resolved by delivery (lane G2-5/G2-6): `audience` says whom the notice is for (the owner of the item, or the next level above them) and `recipient_membership_id` names the owner when it is known.

CREATE TABLE machvon.work_reminder (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  source_id text NOT NULL CHECK (source_id = btrim(source_id) AND char_length(source_id) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind IN ('REMINDER', 'RECLAIM_NOTICE', 'SNOOZE_FINAL_NOTICE')),
  audience text NOT NULL CHECK (audience IN ('OWNER', 'NEXT_LEVEL')),
  recipient_membership_id uuid,
  severity text NOT NULL CHECK (severity IN ('URGENT', 'ACTION', 'WATCH')),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  series_key text NOT NULL CHECK (series_key = btrim(series_key) AND char_length(series_key) BETWEEN 1 AND 200),
  -- The moment it was due by the cadence, and the moment the pass recorded it; the difference is how late the pass was.
  due_at timestamptz NOT NULL,
  cadence_working_hours integer CHECK (cadence_working_hours IS NULL OR cadence_working_hours >= 1),
  policy_version text NOT NULL CHECK (policy_version = btrim(policy_version) AND char_length(policy_version) BETWEEN 1 AND 40),
  action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_membership_id) REFERENCES machvon.membership (tenant_id, id),
  FOREIGN KEY (tenant_id, action_id) REFERENCES machvon.work_action (tenant_id, id),
  CONSTRAINT work_reminder_series_uq UNIQUE (tenant_id, series_key),
  CONSTRAINT work_reminder_audience_chk CHECK ((kind = 'REMINDER' AND audience = 'OWNER') OR (kind <> 'REMINDER' AND audience = 'NEXT_LEVEL'))
);

CREATE INDEX work_reminder_item_idx ON machvon.work_reminder (tenant_id, source_id, source, created_at DESC, id);
CREATE INDEX work_reminder_recipient_idx ON machvon.work_reminder (tenant_id, recipient_membership_id, created_at DESC) WHERE recipient_membership_id IS NOT NULL;

ALTER TABLE machvon.work_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.work_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.work_reminder AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.work_reminder AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.work_reminder FROM machvon_app;

COMMENT ON TABLE machvon.work_reminder IS 'Every reminder and notice to the next level about an item of the alert centre; append-only, one row per reminder of a series.';

-- Indexes that lead with the tenant under every foreign key and reference column, so the reads by that column and the checks of the foreign keys do not scan (rule ST-CTR-013, rls-catalog).
CREATE INDEX work_reminder_action_idx ON machvon.work_reminder (tenant_id, action_id) WHERE action_id IS NOT NULL;
