-- Authored by hand (not generated): the portal boundary of the tables PORTAL-2 adds (V2446 explains the policy; docs/plans/portal2.md).
--   * portal_attachment holds the data of ONE contractor: the portal path answers only its rows.
--   * contractor_portal_invitation (how a contact was let in, with its e-mail and the evidence of the approver) is for staff: the portal path reads and writes nothing there.
--   * document and document_version are denied to the portal path: the portal checks a file through portal_attachment and never reads the register of documents of the tenant, so it cannot probe a document id.
-- Without the setting (staff and jobs) every policy is true.

CREATE POLICY portal_boundary ON machvon.portal_attachment AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL OR contractor_id = nullif(current_setting('app.portal_contractor_id', true), '')::uuid);
CREATE POLICY portal_boundary ON machvon.contractor_portal_invitation AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.document AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
CREATE POLICY portal_boundary ON machvon.document_version AS RESTRICTIVE FOR ALL
  USING (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL)
  WITH CHECK (nullif(current_setting('app.portal_contractor_id', true), '') IS NULL);
