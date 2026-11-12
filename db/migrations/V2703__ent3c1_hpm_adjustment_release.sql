-- Authored by hand: ENT-3c audit (docs/adm-approval-workflow.md, docs/hpm-ebs-connectors.md section 6). An adjustment in the next period (TH.01) that rode on a push the receiver then REJECTED was lost: the push was
-- final, the adjustment stayed APPLIED to it and no later push of the period would carry it again. The receipt of a rejection now gives it back: APPLIED to APPROVED, the link to the push cleared, one journal entry
-- RELEASED with the actor of the receipt. Nothing else moves: a rejected or applied adjustment is otherwise final, an acceptance releases nothing, and the journal stays append-only.
--   * the guard allows APPLIED -> APPROVED only when the push link is cleared in the same statement;
--   * the journal gets the kind RELEASED, and the unique key of the journal now holds for the kinds that happen once (PROPOSED, APPROVED, REJECTED): APPLIED and RELEASED may repeat when an adjustment rides again.

CREATE OR REPLACE FUNCTION machvon.guard_hpm_adjustment() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.layout_code IS DISTINCT FROM OLD.layout_code OR NEW.source_period IS DISTINCT FROM OLD.source_period OR NEW.source_revision IS DISTINCT FROM OLD.source_revision
     OR NEW.target_period IS DISTINCT FROM OLD.target_period OR NEW.subject_code IS DISTINCT FROM OLD.subject_code OR NEW.amount_vnd IS DISTINCT FROM OLD.amount_vnd
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an adjustment keeps what was proposed' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'REJECTED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'an adjustment that was rejected is final' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'APPLIED' AND NEW.state IS DISTINCT FROM OLD.state AND NOT (NEW.state = 'APPROVED' AND NEW.applied_push_id IS NULL AND NEW.applied_at IS NULL) THEN
    RAISE EXCEPTION 'an applied adjustment is given back only by releasing it from its push' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'PROPOSED' AND NEW.state IN ('APPROVED', 'REJECTED')) OR (OLD.state = 'APPROVED' AND NEW.state = 'APPLIED') OR (OLD.state = 'APPLIED' AND NEW.state = 'APPROVED')) THEN
    RAISE EXCEPTION 'an adjustment does not move from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

ALTER TABLE machvon.hpm_adjustment_entry DROP CONSTRAINT hpm_adjustment_entry_kind_chk;
ALTER TABLE machvon.hpm_adjustment_entry ADD CONSTRAINT hpm_adjustment_entry_kind_chk CHECK (kind IN ('PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED', 'RELEASED'));
ALTER TABLE machvon.hpm_adjustment_entry DROP CONSTRAINT hpm_adjustment_entry_uq;
CREATE UNIQUE INDEX hpm_adjustment_entry_once_uq ON machvon.hpm_adjustment_entry (tenant_id, adjustment_id, kind) WHERE kind IN ('PROPOSED', 'APPROVED', 'REJECTED');
