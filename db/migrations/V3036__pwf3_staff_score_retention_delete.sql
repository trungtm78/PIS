-- Authored by hand (not generated): at the end of the retention only the aggregates of a scoring period remain (PWF-3, docs PWF 5 BR-PWF-42, R33). V3033 anonymised the lines in place, but the responses kept
-- `line_id` and `approval_instance_id` (and an approval instance keeps the membership that started it), the adjustments kept the line, and each line kept its unit and its figures: the rows could be put back
-- together with the people who answered. The function now deletes the adjustments, the responses, the signals and the individual lines of the period, and replaces the snapshot of the individuals by a marker.
-- What stays is the period itself: its hash, its dates, its policy and its `summary` (counts and the mean, with no name). The function is still the one door (the tables refuse every other delete), it runs only for
-- the tenant of the transaction and only for official periods whose retention has ended.

CREATE OR REPLACE FUNCTION machvon.pwf_expire_staff_scores(p_period uuid) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = machvon, pg_temp
AS $fn$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_previous text := current_setting('app.scope_units', true);
  v_found uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'a tenant is required to expire the scores of a period' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.scope_units', '*', true);
  SELECT p.id INTO v_found FROM machvon.staff_score_period p
   WHERE p.tenant_id = v_tenant AND p.id = p_period AND p.status = 'OFFICIAL' AND p.erased_at IS NULL
     -- The deadline is judged here too, not only by the job: nobody can erase a period before its policy allows.
     AND p.period_to < ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - make_interval(months => COALESCE((p.snapshot #>> '{policy,params,retention_months}')::int, 60)))::date
   FOR UPDATE;
  IF v_found IS NULL THEN
    PERFORM set_config('app.scope_units', COALESCE(v_previous, ''), true);
    RETURN 0;
  END IF;
  -- Children first: an adjustment names a line and a response, a response names a line.
  DELETE FROM machvon.staff_score_adjustment a
   WHERE a.tenant_id = v_tenant AND a.line_id IN (SELECT l.id FROM machvon.staff_score_line l WHERE l.tenant_id = v_tenant AND l.period_id = p_period);
  DELETE FROM machvon.staff_score_response r
   WHERE r.tenant_id = v_tenant AND r.line_id IN (SELECT l.id FROM machvon.staff_score_line l WHERE l.tenant_id = v_tenant AND l.period_id = p_period);
  DELETE FROM machvon.staff_score_signal s WHERE s.tenant_id = v_tenant AND s.period_id = p_period;
  DELETE FROM machvon.staff_score_line l WHERE l.tenant_id = v_tenant AND l.period_id = p_period;
  UPDATE machvon.staff_score_period p SET snapshot = '{"erased": true}'::jsonb, erased_at = now()
   WHERE p.tenant_id = v_tenant AND p.id = p_period;
  PERFORM set_config('app.scope_units', COALESCE(v_previous, ''), true);
  RETURN 1;
END;
$fn$;

COMMENT ON FUNCTION machvon.pwf_expire_staff_scores(uuid) IS 'Deletes the individual scores, adjustments, responses and signals of one official scoring period of the tenant of the transaction at the end of its retention (PWF-3, BR-PWF-42); the hash and the aggregate summary stay.';
