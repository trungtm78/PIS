-- Authored by hand (not generated): the end of the retention of the personal data of a scoring period (PWF-3, docs PWF 5 BR-PWF-42, R33).
-- Only the facts of the workflow are collected, and they are kept for `retention_months` of the scoring policy (60 by default). When that time has passed for an official period, the data that names a person is
-- anonymised: the lines lose the membership, the contributions and the exclusions, the adjustments and responses lose their words and the person, the signals lose person and tasks, and the snapshot is replaced by a
-- marker; the hash of the snapshot, the computed and adjusted scores and the counts of the period stay, with no name, as aggregate figures. The tables refuse every other change, so the one door is this function:
-- it runs with the rights of the owner of the database, only for the tenant of the transaction, and only for official periods whose retention (`retention_months` of the policy they were locked under, 60 when the
-- snapshot has none) has ended: the deadline is judged inside the function, whoever calls it.

CREATE FUNCTION machvon.pwf_expire_staff_scores(p_period uuid) RETURNS integer
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
  UPDATE machvon.staff_score_adjustment a SET subject_membership_id = NULL, reason = '[erased]', evidence_ref = NULL, decision_note = NULL
   WHERE a.tenant_id = v_tenant AND a.line_id IN (SELECT l.id FROM machvon.staff_score_line l WHERE l.tenant_id = v_tenant AND l.period_id = p_period);
  UPDATE machvon.staff_score_response r SET subject_membership_id = NULL, body = '[erased]', conclusion = NULL
   WHERE r.tenant_id = v_tenant AND r.line_id IN (SELECT l.id FROM machvon.staff_score_line l WHERE l.tenant_id = v_tenant AND l.period_id = p_period);
  UPDATE machvon.staff_score_line l SET membership_id = NULL, contributions = '[]'::jsonb, excluded = '[]'::jsonb, erased_at = now()
   WHERE l.tenant_id = v_tenant AND l.period_id = p_period;
  UPDATE machvon.staff_score_signal s SET membership_id = NULL, task_codes = '[]'::jsonb
   WHERE s.tenant_id = v_tenant AND s.period_id = p_period;
  UPDATE machvon.staff_score_period p SET snapshot = '{"erased": true}'::jsonb, erased_at = now()
   WHERE p.tenant_id = v_tenant AND p.id = p_period;
  PERFORM set_config('app.scope_units', COALESCE(v_previous, ''), true);
  RETURN 1;
END;
$fn$;

REVOKE ALL ON FUNCTION machvon.pwf_expire_staff_scores(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION machvon.pwf_expire_staff_scores(uuid) TO machvon_app;

COMMENT ON FUNCTION machvon.pwf_expire_staff_scores(uuid) IS 'Anonymises the personal data of one official scoring period of the tenant of the transaction at the end of its retention (PWF-3, BR-PWF-42); the hash and the aggregate figures stay.';
