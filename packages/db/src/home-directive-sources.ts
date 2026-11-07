import { directiveClock } from '@machvon/kernel';
import type { DirectivePhase, StoredDirectiveStatus } from '@machvon/kernel';
import { DirectivePolicyReader } from './dir-policy-reader.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, base, reach } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};
const shorten = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** The facet of the severity rules and the key of the consequence of a phase of the clock. */
const FACET: Readonly<Record<Exclude<DirectivePhase, 'DUE_LATER' | 'ENDED'>, 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'ESCALATED'>> = { DUE_SOON: 'DUE_SOON', DUE_TODAY: 'DUE_TODAY', OVERDUE: 'OVERDUE', ESCALATED: 'ESCALATED' };

/**
 * The directives of the steering meetings as a source of the alert centre (governance deepening, lane DIR-1, roadmap CN.03 and QT.02): the clock of the due day of each directive that is not done. Rules (read through
 * the policy reader, `DIRECTIVE_POLICY`, never written here):
 *  - from the earliest reminder day (T-3 by default) until the day it is done, a directive is on the list of the person it is given to, to be acted on (`DIRECTIVE_DUE`: due soon, due today);
 *  - past its due day it is `DIRECTIVE_OVERDUE`, still to be acted on, and from the escalation day (seven days overdue by default) it is urgent and is raised to the head of the assignee unit: whoever reads the unit
 *    (the view `mine` includes the escalated directives of the units the reader's scope covers) sees it as theirs.
 * Owner: the person the directive is given to (else the unit). Expected action: report progress with evidence, ask for an extension with a reason, or close it. Consequence: `CONSEQUENCES.DIRECTIVE_*`.
 */
export class HomeDirectiveSources {
  private readonly policy: DirectivePolicyReader;

  constructor(policy: DirectivePolicyReader = new DirectivePolicyReader()) {
    this.policy = policy;
  }

  async items(context: SourceContext): Promise<SourceRow[]> {
    const reading = await this.policy.get(context.tx, context.today);
    const policy = reading.params;
    const window = Math.max(...policy.reminderDaysBefore);
    const params = new Params();
    const today = params.add(context.today);
    const ahead = params.add(window);
    const seen = reach(params, context, { source: 'DIRECTIVE', id: 'd.id', tenant: 'd', responsible: ['d.assignee_membership_id'], unit: true });
    // The head of the assignee unit: an escalated directive is the reader's when the unit lies in what the reader may read.
    const escalated = (): string => `(d.due_on + ${params.add(policy.escalateAfterOverdueDays)}::int <= ${today}::date and ${params.scope(context.unitScope)})`;
    const where = context.view === 'scope' ? seen : `(${seen} or ${escalated()})`;
    const rows = await context.tx.query<{ id: string; code: string; text: string; status: StoredDirectiveStatus; due_on: string; original_due_on: string; project_code: string | null; unit_code: string }>(
      `select d.id, d.code, d.directive_text as text, d.status, d.due_on::text as due_on, d.original_due_on::text as original_due_on, p.code as project_code, u.code as unit_code
         from machvon.directive d
         ${PROJECT_JOINS('d', 'd.project_id')}
         join machvon.organization_unit u on u.tenant_id = d.tenant_id and u.id = d.assignee_unit_id
        where d.status in ('OPEN', 'IN_PROGRESS') and d.due_on <= ${today}::date + ${ahead}::int and ${where}
        order by d.due_on, d.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = [];
    for (const row of rows) {
      const clock = directiveClock(row.status, row.due_on, context.today, policy);
      if (clock.phase === 'DUE_LATER' || clock.phase === 'ENDED') continue;
      const facet = FACET[clock.phase];
      const overdue = clock.phase === 'OVERDUE' || clock.phase === 'ESCALATED';
      const kind = overdue ? 'DIRECTIVE_OVERDUE' : 'DIRECTIVE_DUE';
      const title = overdue ? `Chỉ đạo quá hạn · ${row.code}` : clock.phase === 'DUE_TODAY' ? `Chỉ đạo đến hạn hôm nay · ${row.code}` : `Chỉ đạo sắp đến hạn · ${row.code}`;
      items.push({
        ...base(kind),
        id: row.id,
        dueOn: row.due_on,
        originalDueOn: row.original_due_on,
        title,
        subtitle: label(row.project_code ?? row.unit_code, shorten(row.text, 90)),
        status: clock.status,
        severity: severityOf('DIRECTIVE', facet, context.rules),
        lifecycle: row.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'NEW',
        consequence: (clock.phase === 'ESCALATED' ? CONSEQUENCES.DIRECTIVE_ESCALATED : overdue ? CONSEQUENCES.DIRECTIVE_OVERDUE : CONSEQUENCES.DIRECTIVE_DUE) ?? null,
        causeKey: null,
        escalation: overdue ? { level: clock.phase === 'ESCALATED' ? 2 : 1, of: 2, nextAt: clock.escalatesOn, chain: ['Người thực hiện', 'Lãnh đạo đơn vị'] } : null,
        target: { screen: 'DIR-04', id: row.id },
      });
    }
    return items;
  }
}
