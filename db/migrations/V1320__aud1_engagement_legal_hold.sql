-- ST-AUD-001: audit and inspection engagements with a scope and a legal hold (AUD 3.1, BR-AUD-10).
--
-- 1. A scope item is one of a unit, a project or a contract, once: the baseline unique index let two identical items in (a NULL is
--    never equal to another NULL), so the index is made over the three columns with NULLS NOT DISTINCT.
-- 2. The dates of an engagement follow its states.
-- 3. `legal_hold_blocks` answers for a mixed scope and for a dossier. An engagement holds the units, projects and contracts of its scope in one
--    hold, so the ids of a hold are matched by what they are (an id is a unit, a project or a contract, never two of them) and not by the
--    kind the hold declares; a dossier is held with the project or contract it is about (subject_id) and with the units its unit lies under.

DROP INDEX machvon.audit_scope_item_scope_uq;
CREATE UNIQUE INDEX audit_scope_item_scope_uq ON machvon.audit_scope_item (tenant_id, engagement_id, scope_kind, organization_unit_id, project_id, contract_id) NULLS NOT DISTINCT;

ALTER TABLE machvon.audit_engagement
  ADD CONSTRAINT audit_engagement_started_chk CHECK (status IN ('PLANNED', 'CANCELLED') OR started_on IS NOT NULL),
  ADD CONSTRAINT audit_engagement_fieldwork_chk CHECK (status <> 'AWAITING_CONCLUSION' OR fieldwork_ended_on IS NOT NULL),
  ADD CONSTRAINT audit_engagement_dates_chk CHECK (fieldwork_ended_on IS NULL OR started_on IS NULL OR fieldwork_ended_on >= started_on),
  ADD CONSTRAINT audit_engagement_cancel_reason_chk CHECK (cancel_reason IS NULL OR length(trim(cancel_reason)) >= 10);

CREATE OR REPLACE FUNCTION machvon.legal_hold_blocks(p_resource_type text, p_resource_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  WITH active AS (
    SELECT h.resource_scope ->> 'kind' AS kind,
           ARRAY(SELECT jsonb_array_elements_text(coalesce(h.resource_scope -> 'ids', '[]'::jsonb)))::uuid[] AS ids
      FROM machvon.legal_hold h
     WHERE h.status = 'Active' AND h.effective_at <= now()
  )
  SELECT EXISTS (
    SELECT 1
      FROM active a
     WHERE a.kind = 'TENANT'
        OR (
          p_resource_id IS NOT NULL
          AND (
            p_resource_id = ANY (a.ids)
            -- a contract is held with its project
            OR (p_resource_type = 'contract'
                AND EXISTS (SELECT 1 FROM machvon.contract c WHERE c.id = p_resource_id AND c.project_id = ANY (a.ids)))
            -- a unit is held with the units above it
            OR (p_resource_type = 'organization_unit'
                AND EXISTS (SELECT 1
                              FROM machvon.organization_unit r
                              JOIN machvon.organization_unit u ON u.id = ANY (a.ids)
                             WHERE r.id = p_resource_id AND starts_with(r.path, u.path)))
            -- a project and a contract are held with the units above their owner
            OR (p_resource_type = 'project'
                AND EXISTS (SELECT 1
                              FROM machvon.project p
                              JOIN machvon.organization_unit r ON r.id = p.owner_unit_id
                              JOIN machvon.organization_unit u ON u.id = ANY (a.ids)
                             WHERE p.id = p_resource_id AND starts_with(r.path, u.path)))
            OR (p_resource_type = 'contract'
                AND EXISTS (SELECT 1
                              FROM machvon.contract c
                              JOIN machvon.project p ON p.id = c.project_id
                              JOIN machvon.organization_unit r ON r.id = p.owner_unit_id
                              JOIN machvon.organization_unit u ON u.id = ANY (a.ids)
                             WHERE c.id = p_resource_id AND starts_with(r.path, u.path)))
            -- a dossier is held with the project or contract it is about, and with the units above its own unit
            OR (p_resource_type = 'dossier'
                AND EXISTS (SELECT 1 FROM machvon.dossier d WHERE d.id = p_resource_id AND d.subject_id = ANY (a.ids)))
            OR (p_resource_type = 'dossier'
                AND EXISTS (SELECT 1
                              FROM machvon.dossier d
                              JOIN machvon.organization_unit r ON r.id = d.organization_unit_id
                              JOIN machvon.organization_unit u ON u.id = ANY (a.ids)
                             WHERE d.id = p_resource_id AND starts_with(r.path, u.path)))
          )
        )
  );
$fn$;
