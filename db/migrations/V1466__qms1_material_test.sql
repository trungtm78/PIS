-- Authored by hand (not generated): the testing of materials and the non-conformance a failed test raises (ST-QMS-007, QMS 3.3, UAT-AC362).
-- The table material_test, its statuses and results, the result that needs a day and a report, the sample code that is unique in a contract, the foreign keys to the project, the contract, the bill item, the report and
-- the non-conformance, and the indexes are in V002. This adds the words of the sample, the order of the days, that the values of the laboratory are an object, that a failed test that has its result names the
-- non-conformance it raised and a test that passed names none, who took the sample, and a guard that what a test is never changes, that its status only moves forward, that the result is written once and that nothing is deleted.

ALTER TABLE machvon.material_test
  ADD CONSTRAINT material_test_text_chk CHECK (
    sample_code = btrim(sample_code) AND sample_code <> '' AND char_length(sample_code) <= 200
    AND material_kind = btrim(material_kind) AND material_kind <> '' AND char_length(material_kind) <= 200
    AND lab_name = btrim(lab_name) AND lab_name <> '' AND char_length(lab_name) <= 200
    AND standard_ref = btrim(standard_ref) AND standard_ref <> '' AND char_length(standard_ref) <= 200
  ),
  ADD CONSTRAINT material_test_dates_chk CHECK (tested_on IS NULL OR tested_on >= sampled_on),
  ADD CONSTRAINT material_test_values_chk CHECK (jsonb_typeof(result_values) = 'object'),
  ADD CONSTRAINT material_test_ncr_chk CHECK (
    (nonconformance_id IS NULL OR result = 'FAIL')
    AND (status <> 'RESULT_RECORDED' OR result <> 'FAIL' OR nonconformance_id IS NOT NULL)
  ),
  ADD CONSTRAINT material_test_sampled_by_fk FOREIGN KEY (tenant_id, sampled_by) REFERENCES machvon.membership (tenant_id, id);

CREATE FUNCTION machvon.guard_material_test() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.project_id, NEW.contract_id, NEW.boq_item_id, NEW.sample_code, NEW.material_kind, NEW.lab_name, NEW.standard_ref, NEW.sampled_on, NEW.sampled_by, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.project_id, OLD.contract_id, OLD.boq_item_id, OLD.sample_code, OLD.material_kind, OLD.lab_name, OLD.standard_ref, OLD.sampled_on, OLD.sampled_by, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'what a material test says never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status, NEW.status) IN (('REGISTERED', 'RESULT_RECORDED'), ('RESULT_RECORDED', 'ACCEPTED'), ('RESULT_RECORDED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'MATERIAL_TEST_STATE_INVALID: this move of the status of a material test is not allowed' USING ERRCODE = '23514';
  END IF;
  -- The result is written once: from the moment it is recorded, the day, the values, the report, the result and the non-conformance are kept as they were.
  IF OLD.status <> 'REGISTERED' AND (NEW.result, NEW.tested_on, NEW.result_values, NEW.report_document_version_id, NEW.nonconformance_id) IS DISTINCT FROM
     (OLD.result, OLD.tested_on, OLD.result_values, OLD.report_document_version_id, OLD.nonconformance_id) THEN
    RAISE EXCEPTION 'the result of a material test is written once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER material_test_guard BEFORE UPDATE ON machvon.material_test
  FOR EACH ROW EXECUTE FUNCTION machvon.guard_material_test();

REVOKE DELETE, TRUNCATE ON machvon.material_test FROM machvon_app;
