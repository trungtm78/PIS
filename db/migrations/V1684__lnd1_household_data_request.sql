-- Authored by hand (not generated): the requests of the people whose data a household holds, and what handling them did to the household (ST-LND-003, LND 3.5, BR-LND-07, UAT-AC381).
-- The household and its flag dsr_open are in V002 and V1683. This adds the record of each request (what was asked, whether the person who asked was verified, the outcome, the reason that was given and
-- the fields that were erased), kept for good and seen only from inside the unit of the household like the household itself, and two marks on the household: that its processing was restricted at the
-- request of the person, and that its personal data was erased (the household stays as an anonymous record, because the payments made to it must be kept).

ALTER TABLE machvon.affected_household
  ADD COLUMN processing_restricted_at timestamptz,
  ADD COLUMN anonymised_at timestamptz;

COMMENT ON COLUMN machvon.affected_household.processing_restricted_at IS 'When the processing of the data was restricted at the request of the person (RESTRICT); the sealed data is not opened while it is set.';
COMMENT ON COLUMN machvon.affected_household.anonymised_at IS 'When the personal data was erased at the request of the person (ERASE, fulfilled); what is left is the code, the unit, the legal basis and the status.';

CREATE TABLE machvon.household_data_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  household_id uuid NOT NULL,
  owner_unit_id uuid NOT NULL,
  request_kind text NOT NULL CHECK (request_kind IN ('ACCESS', 'RECTIFY', 'WITHDRAW_CONSENT', 'ERASE', 'RESTRICT')),
  -- The person who asked was identified before anything was done; a request that was not verified is not handled at all.
  requester_verified boolean NOT NULL CHECK (requester_verified),
  outcome text NOT NULL CHECK (outcome IN ('FULFILLED', 'PARTIAL', 'REFUSED')),
  -- The reason is the words of the officer; it is the record of why a request was refused or only partly met.
  reason text NOT NULL CHECK (reason = btrim(reason) AND reason <> '' AND char_length(reason) <= 2000),
  -- The personal fields that were erased by this request (names of the fields, never their values), and the payment records that had to be kept.
  erased_fields text[] NOT NULL DEFAULT '{}'::text[] CHECK (erased_fields <@ ARRAY['head_name', 'national_id', 'phone', 'address_text']::text[]),
  retained_payments integer NOT NULL DEFAULT 0 CHECK (retained_payments >= 0),
  restricted boolean NOT NULL DEFAULT false,
  handled_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, household_id) REFERENCES machvon.affected_household (tenant_id, id),
  FOREIGN KEY (tenant_id, handled_by) REFERENCES machvon.membership (tenant_id, id),
  -- A request that was refused changes nothing.
  CONSTRAINT household_data_request_refused_chk CHECK (outcome <> 'REFUSED' OR (erased_fields = '{}'::text[] AND NOT restricted))
);

CREATE INDEX household_data_request_household_idx ON machvon.household_data_request (tenant_id, household_id, handled_at);

ALTER TABLE machvon.household_data_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE machvon.household_data_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON machvon.household_data_request AS RESTRICTIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_access ON machvon.household_data_request AS PERMISSIVE FOR ALL
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY scope_units_guard ON machvon.household_data_request AS RESTRICTIVE FOR ALL
  USING (current_setting('app.scope_units', true) = '*' OR owner_unit_id::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')))
  WITH CHECK (current_setting('app.scope_units', true) = '*' OR owner_unit_id::text = ANY (string_to_array(current_setting('app.scope_units', true), ',')));

-- The record of a request is evidence of what was asked and what was done: it is appended and never edited or removed by the runtime role.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE machvon.household_data_request FROM machvon_app;

-- A household that was anonymised stays so: the mark is not cleared, and what was erased is not written back.
CREATE OR REPLACE FUNCTION machvon.guard_affected_household() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REGISTERED' OR NEW.dsr_open OR NEW.anonymised_at IS NOT NULL OR NEW.processing_restricted_at IS NOT NULL THEN
      RAISE EXCEPTION 'HOUSEHOLD_STATE_INVALID: a household is registered first' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.owner_unit_id, NEW.household_code, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.owner_unit_id, OLD.household_code, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a household is never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD.anonymised_at IS NOT NULL AND (NEW.anonymised_at, NEW.head_name, NEW.head_name_enc, NEW.national_id_enc, NEW.national_id_hash, NEW.national_id_masked, NEW.phone_enc, NEW.phone_masked, NEW.address_text, NEW.address_enc)
     IS DISTINCT FROM (OLD.anonymised_at, OLD.head_name, OLD.head_name_enc, OLD.national_id_enc, OLD.national_id_hash, OLD.national_id_masked, OLD.phone_enc, OLD.phone_masked, OLD.address_text, OLD.address_enc) THEN
    RAISE EXCEPTION 'HOUSEHOLD_STATE_INVALID: an anonymised household does not get its personal data back' USING ERRCODE = '23514';
  END IF;
  IF OLD.processing_restricted_at IS NOT NULL AND NEW.processing_restricted_at IS NULL THEN
    RAISE EXCEPTION 'HOUSEHOLD_STATE_INVALID: the restriction of the processing is not lifted here' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('REGISTERED', 'INVENTORIED'), ('INVENTORIED', 'PLAN_LISTED'), ('PLAN_LISTED', 'COMPENSATED'), ('COMPENSATED', 'RESETTLED'), ('COMPENSATED', 'CLOSED'), ('RESETTLED', 'CLOSED'),
        ('REGISTERED', 'DISPUTED'), ('INVENTORIED', 'DISPUTED'), ('PLAN_LISTED', 'DISPUTED'),
        ('DISPUTED', 'INVENTORIED'), ('DISPUTED', 'PLAN_LISTED'), ('DISPUTED', 'COMPENSATED')
      ) AS allowed (from_status, to_status)
     WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'HOUSEHOLD_STATE_INVALID: this move of the status is not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;
