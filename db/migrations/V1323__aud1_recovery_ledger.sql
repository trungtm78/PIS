-- ST-AUD-004: the ledger of the financial recoveries of the recommendations and its reconciliation with PAY (AUD 3.4, BR-AUD-01 to BR-AUD-04).
--
-- 1. The ledger only grows: a recovery is never changed or deleted, a mistake is put right by a line of the opposite sign (V002 keeps the sign and the reversal in step).
-- 2. A line moves `recovered_vnd` of its recommendation in the same transaction, whoever writes it (the command, the consumer of the PAY events, a later job): the sum of the lines is the
--    recovered amount by construction, and a line that would take it above the amount recommended, or below nothing, is refused by the CHECKs of the recommendation (V002).
--    Only a financial recommendation takes a line.
-- 3. A recovery the ledger cannot take (PAY recovered more than was recommended, or reversed one that was never linked) is kept as an exception for the accountant, not dropped and not forced in.
-- 4. A recommendation that was closed and is reopened because a recovery was reversed says when.

ALTER TABLE machvon.audit_recommendation ADD COLUMN reopened_at timestamptz;
-- The reason of a reversal, and what an accountant says of a line entered by hand: words, kept with the line and out of the trail.
ALTER TABLE machvon.audit_recovery_link ADD COLUMN note text;
ALTER TABLE machvon.audit_recovery_link ADD CONSTRAINT audit_recovery_link_note_chk CHECK (note IS NULL OR length(trim(note)) >= 1);

CREATE FUNCTION machvon.audit_recovery_link_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'the ledger of recoveries only grows: a line is put right by a line of the opposite sign' USING ERRCODE = '23514', CONSTRAINT = 'audit_recovery_link_append_only';
END
$fn$;

CREATE TRIGGER audit_recovery_link_append_only
  BEFORE UPDATE OR DELETE ON machvon.audit_recovery_link
  FOR EACH ROW EXECUTE FUNCTION machvon.audit_recovery_link_append_only();

CREATE FUNCTION machvon.audit_recovery_link_apply() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  kind text;
BEGIN
  -- The recommendation is locked by the update itself, so two lines for the same recommendation are applied one after the other.
  SELECT r.rec_type INTO kind FROM machvon.audit_recommendation r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.recommendation_id FOR UPDATE;
  IF kind IS NULL OR kind NOT IN ('FINANCIAL_RECOVERY', 'FINANCIAL_ADJUSTMENT') THEN
    RAISE EXCEPTION 'only a financial recommendation takes a recovery' USING ERRCODE = '23514', CONSTRAINT = 'audit_recovery_link_financial_guard';
  END IF;
  UPDATE machvon.audit_recommendation
     SET recovered_vnd = recovered_vnd + NEW.amount_vnd, updated_at = now(), version = version + 1
   WHERE tenant_id = NEW.tenant_id AND id = NEW.recommendation_id;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_recovery_link_apply
  AFTER INSERT ON machvon.audit_recovery_link
  FOR EACH ROW EXECUTE FUNCTION machvon.audit_recovery_link_apply();

CREATE TABLE machvon.audit_recovery_exception (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OVER_RECOVERY', 'UNMATCHED_REVERSAL', 'NOT_APPLICABLE')),
  source_kind text NOT NULL CHECK (source_kind IN ('PAY_RECOVERY', 'PAY_DEDUCTION')),
  source_id uuid,
  source_event_id uuid NOT NULL,
  amount_vnd numeric(24,0) NOT NULL CHECK (amount_vnd > 0),
  recorded_on date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE machvon.audit_recovery_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.audit_recovery_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON machvon.audit_recovery_exception AS PERMISSIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_boundary ON machvon.audit_recovery_exception AS RESTRICTIVE FOR ALL USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE machvon.audit_recovery_exception ADD FOREIGN KEY (tenant_id, recommendation_id) REFERENCES machvon.audit_recommendation (tenant_id, id);
CREATE UNIQUE INDEX audit_recovery_exception_event_uq ON machvon.audit_recovery_exception (tenant_id, source_event_id, kind);
CREATE INDEX audit_recovery_exception_recommendation_idx ON machvon.audit_recovery_exception (tenant_id, recommendation_id, status);
