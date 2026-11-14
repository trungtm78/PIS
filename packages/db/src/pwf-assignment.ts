import { DomainError, legalDocument, pwfAssignment, pwfWorkflow } from '@machvon/kernel';
import type { ResolvedGovernanceRule } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Which kind of workflow a project takes (PWF-4, R47), the templates the tenant has, and the catalogue of legal documents the templates cite (R45): the reads behind the registration of a project (PRJ-02), the start and the adoption
 * of a workflow (PWF-05) and the screens that show legal grounds. Everything is read through the governance port inside the transaction of the caller: the approved rule in force on the day, else the built-in default.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACT_VALUE = /^[A-Za-z0-9_.-]{1,40}$/;

export interface TemplateOption {
  code: string;
  name: string;
  projectType: string | null;
  version: number;
  ruleId: string | null;
  unverified: boolean;
  phaseCount: number;
  stepCount: number;
  taskCount: number;
  /** The facts a branch of the template reads: the person is asked for the ones the project does not know. */
  factFields: string[];
}

export interface AssignmentRuleRef {
  ruleId: string | null;
  version: number;
  unitId: string | null;
  unverified: boolean;
}

export interface SuggestionView {
  suggestion: pwfAssignment.WorkflowSuggestion;
  rule: AssignmentRuleRef;
  templates: TemplateOption[];
  facts: pwfWorkflow.ProjectFacts;
}

/** How the template of a workflow was chosen, as the row of the workflow keeps it (`project_workflow.selection`). */
export interface SelectionRecord {
  mode: pwfAssignment.SelectionMode;
  chosen_template_code: string;
  suggested_template_code: string | null;
  basis: pwfAssignment.SuggestionBasis;
  line: string | null;
  rule_id: string | null;
  rule_version: number;
  rule_unit_id: string | null;
  reason: string | null;
}

/** A legal document of the catalogue with what it is on a day. */
export interface LegalDocumentView extends legalDocument.LegalDocument {
  state: legalDocument.LegalDocumentState;
  /** The version of the rule that says so (0: the built-in entry). */
  ruleVersion: number;
}

/** A legal ground as a screen shows it: the citation of the template and the document of the catalogue it cites (null when the catalogue no longer has the code). */
export interface LegalBasisView {
  document_code: string;
  article: string | null;
  note: string | null;
  verification: string;
  doc_kind: string | null;
  number: string | null;
  title: string | null;
  issuer: string | null;
  effective_from: string | null;
  effective_to: string | null;
  superseded_by: string | null;
  superseded_by_number: string | null;
  document_verification: string | null;
  document_id: string | null;
  url: string | null;
  state: legalDocument.LegalDocumentState | 'UNKNOWN';
}

export const legalBasisView = (basis: pwfWorkflow.TemplateLegalBasis, catalogue: ReadonlyMap<string, LegalDocumentView>): LegalBasisView => {
  const document = catalogue.get(basis.document);
  return {
    document_code: basis.document,
    article: basis.article,
    note: basis.note,
    verification: basis.verification,
    doc_kind: document?.kind ?? null,
    number: document?.number ?? null,
    title: document?.title ?? null,
    issuer: document?.issuer ?? null,
    effective_from: document?.effectiveFrom ?? null,
    effective_to: document?.effectiveTo ?? null,
    superseded_by: document?.supersededBy ?? null,
    // The document that replaced it, as people cite it (its number in the catalogue); null when nothing replaced it or the catalogue does not have the replacement.
    superseded_by_number: document?.supersededBy === null || document?.supersededBy === undefined ? null : (catalogue.get(document.supersededBy)?.number ?? null),
    document_verification: document?.verification ?? null,
    document_id: document?.documentId ?? null,
    url: document?.url ?? null,
    state: document?.state ?? 'UNKNOWN',
  };
};

export class PwfAssignmentReads {
  private readonly policy: GovernancePolicyPort;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.policy = policy;
  }

  /** The templates in force on the day (approved rules and built-in defaults); a rule whose params no longer parse is left out rather than offered. */
  async templates(tx: TenantTx, asOf: string): Promise<TemplateOption[]> {
    const rules = await this.policy.getAll(tx, pwfWorkflow.PROJECT_WORKFLOW_RULE_TYPE, asOf);
    const options: TemplateOption[] = [];
    for (const rule of rules) {
      let template: pwfWorkflow.ProjectWorkflowTemplate;
      try {
        template = pwfWorkflow.parseProjectWorkflowTemplate(rule.params);
      } catch (error) {
        if (error instanceof DomainError) continue;
        throw error;
      }
      options.push({
        code: rule.code,
        name: template.name,
        projectType: template.projectType,
        version: rule.version,
        ruleId: rule.ruleId,
        unverified: rule.unverified,
        phaseCount: template.phases.length,
        stepCount: pwfWorkflow.stepsOf(template).length,
        taskCount: template.tasks.length,
        factFields: [...new Set(template.tasks.flatMap((one) => one.when.map((condition) => condition.field)))].sort(),
      });
    }
    return options;
  }

  /** The units above a unit and the unit itself, nearest first (the chain a rule of a unit is looked up along); a unit that does not exist is 422. */
  async unitChain(tx: TenantTx, unitId: string | null | undefined): Promise<string[]> {
    if (unitId === null || unitId === undefined) return [];
    if (!UUID.test(unitId)) throw new DomainError('VALIDATION_FAILED', 422, 'owner_unit_id');
    const rows = await tx.query<{ id: string }>(`select a.id from machvon.organization_unit u join machvon.organization_unit a on starts_with(u.path, a.path) where u.id = $1::uuid order by length(a.path) desc`, [unitId.toLowerCase()]);
    if (rows.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'owner_unit_id');
    return rows.map((row) => row.id);
  }

  /** What the rule in force for the unit (or the tenant) suggests for a project with these facts. */
  async suggest(tx: TenantTx, input: { facts: Record<string, string | undefined>; unitId?: string | null | undefined; asOf: string }): Promise<SuggestionView> {
    const facts: Record<string, string> = {};
    for (const [field, value] of Object.entries(input.facts)) {
      if (value === undefined || value === '') continue;
      if (!(pwfWorkflow.CONDITION_FIELDS as readonly string[]).includes(field) || !FACT_VALUE.test(value)) throw new DomainError('VALIDATION_FAILED', 422, `facts.${field}`);
      facts[field] = value;
    }
    const unitChain = await this.unitChain(tx, input.unitId);
    const rule: ResolvedGovernanceRule | undefined = await this.policy.get(tx, pwfAssignment.WORKFLOW_ASSIGNMENT_RULE_TYPE, pwfAssignment.WORKFLOW_ASSIGNMENT_CODE, input.asOf, { unitChain });
    const templates = await this.templates(tx, input.asOf);
    const assignment = rule === undefined ? { lines: [], defaultTemplateCode: null } : pwfAssignment.parseWorkflowAssignment(rule.params);
    const suggestion = pwfAssignment.suggestWorkflowTemplate(assignment, facts, templates.map((one) => ({ code: one.code, projectType: one.projectType })));
    return { suggestion, rule: { ruleId: rule?.ruleId ?? null, version: rule?.version ?? 0, unitId: rule?.unitId ?? null, unverified: rule?.unverified ?? false }, templates, facts };
  }

  /** The facts a project is known by before anyone types one: its group, and its type as the master data names it (when the name can be a fact). */
  async projectFacts(tx: TenantTx, projectId: string): Promise<{ facts: Record<string, string>; ownerUnitId: string | null }> {
    const rows = await tx.query<{ project_group: string | null; project_type: string | null; owner_unit_id: string | null }>(
      `select p.project_group, r.business_key as project_type, p.owner_unit_id
         from machvon.project p
         left join machvon.master_record_version v on v.id = p.project_type_master_version_id
         left join machvon.master_record r on r.id = v.master_record_id
        where p.id = $1::uuid`,
      [projectId],
    );
    const row = rows[0];
    const facts: Record<string, string> = {};
    if (row?.project_group != null && FACT_VALUE.test(row.project_group)) facts.project_group = row.project_group;
    if (row?.project_type != null && FACT_VALUE.test(row.project_type)) facts.project_type = row.project_type;
    return { facts, ownerUnitId: row?.owner_unit_id ?? null };
  }

  /** The catalogue of legal documents on a day, by code: what each is (in force, not yet, expired, replaced). */
  async legalDocuments(tx: TenantTx, today: string): Promise<Map<string, LegalDocumentView>> {
    const rules = await this.policy.getAll(tx, legalDocument.LEGAL_DOCUMENT_RULE_TYPE, today);
    const found = new Map<string, LegalDocumentView>();
    for (const rule of rules) {
      const document = legalDocument.legalDocumentOf(rule.code, rule.params);
      found.set(rule.code, { ...document, state: legalDocument.legalDocumentState(document, today), ruleVersion: rule.version });
    }
    return found;
  }
}

/** The record of a choice (R47): what the rule suggested, what was chosen and how; choosing against the rule needs a reason where the caller says so. */
export function selectionRecordOf(view: SuggestionView, chosen: string | undefined, reason: string | undefined, reasonRequired: boolean): SelectionRecord {
  const suggested = view.suggestion.templateCode;
  const mode = pwfAssignment.selectionModeOf(suggested, chosen);
  const templateCode = chosen ?? suggested;
  if (templateCode === null) throw new DomainError('PWF_TEMPLATE_NOT_ASSIGNED', 422, 'template_code');
  let note: string | null = null;
  if (reason !== undefined) {
    const trimmed = reason.trim();
    // eslint-disable-next-line no-control-regex
    if (trimmed.length < pwfAssignment.MIN_OVERRIDE_REASON || trimmed.length > pwfAssignment.MAX_OVERRIDE_REASON || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) throw new DomainError('VALIDATION_FAILED', 422, 'selection_reason');
    note = trimmed;
  }
  if (mode === 'OVERRIDE' && reasonRequired && note === null) throw new DomainError('PWF_SELECTION_REASON_REQUIRED', 422, 'selection_reason', { extensions: { suggested_template_code: suggested } });
  return { mode, chosen_template_code: templateCode, suggested_template_code: suggested, basis: view.suggestion.basis, line: view.suggestion.line, rule_id: view.rule.ruleId, rule_version: view.rule.version, rule_unit_id: view.rule.unitId, reason: note };
}
