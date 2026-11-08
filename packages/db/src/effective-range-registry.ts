/**
 * How the tables that carry an effective range are judged (ST-KERNEL-060, NFR-LEGAL-02). A law change is a new version with its own range, never an edit of the old one, so the
 * answer to "which rule governed this date" must be one version. Every table of the schema that has a start and an end of validity is declared here, and
 * `packages/db/test/effective-range-lint.test.ts` fails when a table has such a range and is not declared, when a declared guard does not exist, or when the range has no
 * check that it ends after it starts.
 *
 *   RULE      versions of a rule, a template or a policy; two published versions of one key never cover the same day. `guard` names what holds it in the database: an
 *             exclusion constraint on the daterange of the key, or a trigger (used where the key is not a plain column list).
 *   VALIDITY  the period during which one thing is valid or held (a membership, a permit, a certificate, a grant); there is no "version of a rule" to resolve, the period is a fact
 *             about the record, and `reason` says why a second record over the same days is allowed or handled elsewhere.
 *   SERIES    versions that only have a start (the next start ends the previous one), so they cannot overlap.
 *   PENDING   a rule-like table without its guard yet; `reason` names what is missing and who adds it. The lint lists them so that a new one is noticed, and a table leaves this
 *             class when it gets its guard.
 */
export type RangeKind = 'RULE' | 'VALIDITY' | 'SERIES' | 'PENDING';

export interface RangeGuard {
  type: 'EXCLUDE' | 'TRIGGER';
  /** The name of the exclusion constraint or of the trigger in the database. */
  name: string;
}

export interface RangeDeclaration {
  table: string;
  kind: RangeKind;
  guard?: RangeGuard;
  reason?: string;
}

const exclude = (table: string, name: string): RangeDeclaration => ({ table, kind: 'RULE', guard: { type: 'EXCLUDE', name } });
const validity = (table: string, reason: string): RangeDeclaration => ({ table, kind: 'VALIDITY', reason });

export const EFFECTIVE_RANGE_TABLES: readonly RangeDeclaration[] = [
  exclude('document_template', 'document_template_range_excl'),
  exclude('issue_sla_policy', 'issue_sla_policy_no_overlap'),
  exclude('master_record_version', 'master_version_no_overlap'),
  exclude('mne_obligation_rule', 'mne_rule_no_overlap'),
  exclude('mne_report_form', 'mne_form_no_overlap'),
  exclude('permit_gate_rule', 'permit_gate_rule_no_overlap'),
  exclude('permit_type', 'permit_type_no_overlap'),
  exclude('doc_type', 'doc_type_no_overlap'),
  exclude('doc_retention_rule', 'doc_retention_rule_no_overlap'),
  exclude('document_layout_profile', 'document_layout_profile_no_overlap'),
  exclude('early_warning_rule', 'early_warning_rule_no_overlap'),
  exclude('doa_matrix_version', 'doa_matrix_version_no_overlap'),
  // The availability control policy judges overlap in a trigger (V1365): its key is a scope that is a unit, a text or nothing.
  { table: 'avc_policy', kind: 'RULE', guard: { type: 'TRIGGER', name: 'avc_policy_guard' } },
  { table: 'pricing_version', kind: 'SERIES', reason: 'only a start (effective_from): the next price of a model ends the previous one, so two prices never cover one instant' },
  {
    table: 'metric_definition',
    kind: 'PENDING',
    reason: 'the metric registry has no publisher yet (the BI story that publishes a metric adds the exclusion on (tenant_id, code, range) where status is published, as the other rules have)',
  },
  validity('ai_external_exception', 'the period an approved exception for an outside AI call holds; several exceptions of one subject may stand at once, each use is checked against its own'),
  validity('alert_absence', 'the period a person is declared absent; absences of one person may be declared one after another and a cover points at its own absence'),
  validity('alert_absence_cover', 'the period a deputy covers an absence; one absence may be covered by several deputies'),
  validity('committee_member', 'the period a person sits on a committee; a person may sit on several committees and the roster keeps the history'),
  validity('restriction_case', 'the period a decided restriction on a vendor holds; it is a fact of the decided case, not a version of a rule'),
  validity('contract_party', 'the period a party is on a contract; the same party may hold two roles at once'),
  validity('contract_revision', 'the period one revision of a contract is the one in force, set by the amendment flow of CTR'),
  validity('contractor_restriction', 'a debarment, a suspension and a warning of one contractor may run together (the kind distinguishes them)'),
  validity('delegation_grant', 'a delegation to one person for a period; several delegations may stand at once'),
  validity('entitlement_override', 'a support override of one entitlement for a period, ended by its own rows'),
  validity('license_revision', 'the period of one revision of a licence, set by the licence flow of SAS'),
  validity('master_crosswalk', 'the period a mapping between two codes is valid; several mappings of one code may be valid together'),
  validity('membership', 'the period a person belongs to a tenant'),
  validity('organization_unit', 'the period an organisation unit exists, with its history kept by the succession of units'),
  validity('permit', 'the period a permit of a project is valid; it is a fact about the permit, not a version of a rule'),
  validity('project_accountability', 'the period a person answers for a project; several people may at once'),
  validity('project_component', 'the period a component of a project exists'),
  validity('role_grant', 'the period a role is granted to a membership; a person may hold several'),
  validity('signing_certificate', 'the period a certificate is valid; a holder may have several'),
  validity('sync_membership_scope', 'the period of a data scope synced to a device'),
  validity('task_force', 'the period a task force exists'),
  validity('task_force_member', 'the period a person is a member of a task force'),
];
