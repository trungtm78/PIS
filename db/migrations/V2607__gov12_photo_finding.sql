-- Authored by hand (not generated): the review register of site photos across projects (GOV-12, G4-12 should-have part). The check of one photo in QMS (site_photo.check_*) is a flag; this table holds the pairs that
-- no single photo can show: the same file in two projects, the same place at the same moment in two projects, the same file on two days of one project. A finding is a signal for a person, never a statement that a photo
-- is false. The pair is stored once (the smaller photo id first); the move of the review is a row of photo_finding_event, appended.

CREATE TABLE machvon.photo_finding (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('SAME_FILE_OTHER_PROJECT', 'SAME_PLACE_AND_MOMENT_OTHER_PROJECT', 'SAME_FILE_OTHER_DAY')),
  first_photo_id uuid NOT NULL,
  second_photo_id uuid NOT NULL,
  first_project_id uuid NOT NULL,
  second_project_id uuid NOT NULL,
  metres integer CHECK (metres IS NULL OR metres >= 0),
  minutes numeric(8, 1) CHECK (minutes IS NULL OR minutes >= 0),
  rule_version integer NOT NULL CHECK (rule_version >= 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_REVIEW', 'EXPLAINED', 'REFERRED')),
  reviewer_membership_id uuid,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 10 AND 2000)),
  first_flagged_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, first_photo_id) REFERENCES machvon.site_photo (tenant_id, id),
  FOREIGN KEY (tenant_id, second_photo_id) REFERENCES machvon.site_photo (tenant_id, id),
  FOREIGN KEY (tenant_id, first_project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, second_project_id) REFERENCES machvon.project (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT photo_finding_pair_uq UNIQUE (tenant_id, first_photo_id, second_photo_id),
  CONSTRAINT photo_finding_order_chk CHECK (first_photo_id < second_photo_id),
  CONSTRAINT photo_finding_reason_chk CHECK (status NOT IN ('EXPLAINED', 'REFERRED') OR reason IS NOT NULL)
);
CREATE INDEX photo_finding_queue_idx ON machvon.photo_finding (tenant_id, status, first_flagged_at, id);
CREATE INDEX photo_finding_second_photo_idx ON machvon.photo_finding (tenant_id, second_photo_id);
CREATE INDEX photo_finding_first_project_idx ON machvon.photo_finding (tenant_id, first_project_id);
CREATE INDEX photo_finding_second_project_idx ON machvon.photo_finding (tenant_id, second_project_id);
CREATE INDEX photo_finding_reviewer_idx ON machvon.photo_finding (tenant_id, reviewer_membership_id) WHERE reviewer_membership_id IS NOT NULL;
ALTER TABLE machvon.photo_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.photo_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.photo_finding AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.photo_finding AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE DELETE, TRUNCATE, UPDATE ON TABLE machvon.photo_finding FROM machvon_app;
GRANT UPDATE (status, reviewer_membership_id, reason, version) ON TABLE machvon.photo_finding TO machvon_app;

CREATE TABLE machvon.photo_finding_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('FLAGGED', 'TAKE', 'EXPLAIN', 'REFER', 'REOPEN')),
  to_status text NOT NULL CHECK (to_status IN ('OPEN', 'IN_REVIEW', 'EXPLAINED', 'REFERRED')),
  actor_membership_id uuid,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 2000)),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, finding_id) REFERENCES machvon.photo_finding (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_membership_id) REFERENCES machvon.membership (tenant_id, id),
  CONSTRAINT photo_finding_event_actor_chk CHECK ((move = 'FLAGGED') = (actor_membership_id IS NULL))
);
CREATE INDEX photo_finding_event_finding_idx ON machvon.photo_finding_event (tenant_id, finding_id, at, id);
CREATE INDEX photo_finding_event_actor_idx ON machvon.photo_finding_event (tenant_id, actor_membership_id) WHERE actor_membership_id IS NOT NULL;
ALTER TABLE machvon.photo_finding_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.photo_finding_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.photo_finding_event AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.photo_finding_event AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.photo_finding_event FROM machvon_app;

COMMENT ON TABLE machvon.photo_finding IS 'Pairs of site photos that need a person to explain them (same file or same place and moment in two projects); a signal, never a conclusion.';
