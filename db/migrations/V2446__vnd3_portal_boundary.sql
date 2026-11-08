-- Authored by hand (not generated): the portal is a separate access path, and the database holds its boundary (VND-3, research V15; docs/vendor-investigation.md section 5).
-- A contractor reaches the data through the portal operations, which run in the usual tenant transaction and, in addition, set `app.portal_contractor_id` to the contractor the guest membership is bound to (never to a value
-- the caller sends). While that setting is present:
--   * every table that holds data of ONE contractor (its profile, owners, certificates, key staff, evaluations, requests, confirmations, remediation plans) answers only the rows of that contractor (RESTRICTIVE policy portal_boundary,
--     in addition to tenant_boundary and tenant_access);
--   * every table of the investigation (red flags, leads, links, screening, the trace of the submissions), of the debarment register, of the accounts, of the duplicate suggestions and of the reputation ledger answers nothing at
--     all and accepts no row: a contractor never reads a red flag, a lead, another contractor, and never writes there.
-- Without the setting (staff and jobs) the policy is true, so nothing changes for the existing code. The catalogue test (rls-catalog) knows the one extra policy name and the exact lists below.

CREATE POLICY portal_boundary ON machvon.contractor AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_owner AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_qualification AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_key_staff AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_performance AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_portal_request AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_portal_request_event AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_reconfirmation AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_remediation_plan AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_remediation_action AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_remediation_event AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.red_flag_finding AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.red_flag_review AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.red_flag_involved AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.red_flag_scan AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.vendor_link_scan AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_party_link AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.vendor_investigation_lead AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.vendor_lead_involved AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.vendor_lead_review AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.screening_list_import AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.screening_list_entry AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.screening_run AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.screening_hit AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.screening_hit_event AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.proposal_submission_trace AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.proposal_submission_file AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_duplicate_suggestion AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_reputation_event AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_restriction AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.restriction_case AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.restriction_case_member AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.restriction_case_event AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_bank_account AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_bank_change_request AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.contractor_bank_event AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.egp_record AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.bid_conflict_declaration AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
