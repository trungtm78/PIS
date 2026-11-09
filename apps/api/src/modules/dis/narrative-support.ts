import { PERMISSIONS } from '@machvon/contracts';
import { DirDirectiveStore, EntNarrativeStore, directiveScope } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError, NARRATIVE_FIELDS, unchangedInherited } from '@machvon/kernel';
import type { EffectiveAccess, EnterpriseNarrative, NarrativeInput } from '@machvon/kernel';

/**
 * The narrative of a report as the API gives and takes it (ENT-3b). The enterprise block is judged here against the register before it is written: a standard cause must be an entry in use of the list, a
 * directive that is rolled up must be one the caller sees among the directives of the period of the project (DIR-05), and what the server knows of it (its code and its state on the last day) replaces what the
 * request said, so a block never carries a claim about a directive that the register does not make.
 */
const causes = new EntNarrativeStore();
const directives = new DirDirectiveStore();

/** The enterprise block as the contract names it. `inheritance` is only ever given back, never taken. */
export function enterpriseView(block: EnterpriseNarrative): Record<string, unknown> {
  return {
    status: block.fields.status,
    schedule: block.fields.schedule,
    disbursement: block.fields.disbursement,
    causes: block.fields.causes,
    difficulties: block.fields.difficulties,
    solutions: block.fields.solutions,
    next_plan: block.fields.next_plan,
    proposals: block.fields.proposals,
    cause_codes: [...block.causeCodes],
    directive_refs: block.directiveRefs.map((ref) => ({ id: ref.id, code: ref.code, status_at_end: ref.statusAtEnd })),
    inheritance:
      block.inheritance === undefined
        ? null
        : {
            from_report_id: block.inheritance.fromReportId,
            from_period_id: block.inheritance.fromPeriodId,
            at: block.inheritance.at,
            by: block.inheritance.by,
            fields: Object.keys(block.inheritance.hashes),
            unchanged_fields: unchangedInherited(block, block.inheritance),
          },
  };
}

/** The narrative of a report as the detail shows it: the public sections and, when there is one, the enterprise block. */
export function narrativeView(narrative: NarrativeInput | null): Record<string, unknown> | null {
  if (narrative === null) return null;
  return {
    results: narrative.resultsText,
    causes: narrative.causesText,
    solutions: narrative.solutionsText,
    proposals: narrative.proposalsText,
    linked_issue_ids: [...narrative.linkedIssueIds],
    ...(narrative.enterprise === undefined ? {} : { enterprise: enterpriseView(narrative.enterprise) }),
  };
}

export interface NarrativeJudgeContext {
  access: EffectiveAccess;
  projectId: string;
  period: { startDate: string; endDate: string };
  now: Date;
}

/**
 * Holds the enterprise block of a request to the register: every cause code is an entry in use of the list MDM-17 (422 `VALIDATION_FAILED` naming
 * `narrative.enterprise.cause_codes[i]`), every directive is one of the period of the project in the caller's reach (422 naming `narrative.enterprise.directive_refs[i].id`) and the code and the state the request
 * claims for it are the ones the register has (422 naming the member). Nothing is rewritten, so the hash of a replayed request does not move; a narrative without a block costs nothing.
 */
export async function judgeNarrative(tx: TenantTx, narrative: NarrativeInput | null | undefined, context: NarrativeJudgeContext): Promise<void> {
  const block = narrative?.enterprise;
  if (block === undefined) return;
  const unknown = await causes.unknownCodes(tx, block.causeCodes);
  const first = unknown[0];
  if (first !== undefined) throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.cause_codes[${block.causeCodes.indexOf(first)}]`);
  if (block.directiveRefs.length === 0) return;
  const view = await directives.forReport(tx, directiveScope(context.access, PERMISSIONS.getDirective, context.now), { from: context.period.startDate, to: context.period.endDate }, { projectId: context.projectId });
  const byId = new Map(view.items.map((item) => [item.id, item]));
  block.directiveRefs.forEach((ref, index) => {
    const found = byId.get(ref.id);
    if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.directive_refs[${index}].id`);
    if (found.code !== ref.code) throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.directive_refs[${index}].code`);
    if (found.statusAtEnd !== ref.statusAtEnd) throw new DomainError('VALIDATION_FAILED', 422, `narrative.enterprise.directive_refs[${index}].status_at_end`);
  });
}

/** What the audit trail keeps of the block: how many fields have words, how many causes and directives; never the words. */
export function enterpriseTrail(block: EnterpriseNarrative | undefined): Record<string, unknown> {
  if (block === undefined) return {};
  return {
    enterprise_fields: NARRATIVE_FIELDS.filter((field) => block.fields[field] !== null).length,
    enterprise_causes: block.causeCodes.length,
    enterprise_directives: block.directiveRefs.length,
  };
}
