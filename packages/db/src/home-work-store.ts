import type { WorkItem, WorkKind } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** A task of a person, with what the screen needs to take them to it. */
export interface WorkRow extends WorkItem {
  /** The place the task is opened from: the screen and the id it is about. */
  target: { screen: string; id: string };
}

const VIETNAM_DAY = (column: string): string => `((${column}) at time zone 'Asia/Ho_Chi_Minh')::date::text`;
/** The most a source gives (a person with more than this has a list that says it is cut: the counts are then a lower bound). */
export const WORK_SOURCE_LIMIT = 2000;
const LIMIT = WORK_SOURCE_LIMIT;
/** How many days ahead an obligation of the unit of the person is shown. */
const MNE_AHEAD_DAYS = 14;

export interface WorkInput {
  membershipId: string;
  now: Date;
  today: string;
  /** The units the person may read (alias `u`) and the projects they may read (the aliases of the register queries): what they wrote is theirs to see only while they may read the place it is about. */
  unitScope: ScopeBuilder;
  projectScope: ScopeBuilder;
}

/**
 * What is asked of one person across the modules (ST-HOME-004, HOME 3 F5): the approvals that wait for them (ADM), the explanations they owe and the ones they asked for and must conclude (PRJ), the reports of theirs that
 * came back or that are drafts past their period (DIS), and the monitoring reports of their unit that are near their day (MNE). HOME keeps none of it: every read is of the person, by their membership, so another
 * person's work never appears, and each is a read of the table of the module.
 */
export class HomeWorkStore {
  async collect(tx: TenantTx, input: WorkInput): Promise<{ rows: WorkRow[]; truncated: boolean }> {
    const sources = [await this.approvals(tx, input), await this.explanationsOwed(tx, input), await this.explanationsToConclude(tx, input), await this.reports(tx, input), await this.obligations(tx, input)];
    return { rows: sources.flat(), truncated: sources.some((source) => source.length >= LIMIT) };
  }

  private async approvals(tx: TenantTx, input: { membershipId: string }): Promise<WorkRow[]> {
    const rows = await tx.query<{ id: string; due_on: string; resource_type: string }>(
      `select a.id, ${VIETNAM_DAY('a.due_at')} as due_on, i.document_type as resource_type
         from machvon.approval_task a join machvon.workflow_instance i on i.tenant_id = a.tenant_id and i.id = a.workflow_instance_id
        where a.assignee_id = $1::uuid and a.status = 'Pending' and a.decided_at is null and a.decision is null
        order by a.due_at, a.id limit ${LIMIT}`,
      [input.membershipId],
    );
    return rows.map((row) => ({ id: row.id, kind: 'APPROVAL' as WorkKind, dueOn: row.due_on, originalDueOn: row.due_on, title: row.resource_type, subtitle: null, status: 'PENDING', target: { screen: 'ADM-06', id: row.id } }));
  }

  /** The explanations that were asked of the person and are not answered: asked, sent back, or late. */
  private async explanationsOwed(tx: TenantTx, input: { membershipId: string }): Promise<WorkRow[]> {
    const rows = await tx.query<{ id: string; question: string; status: string; due_on: string; original_due_on: string; project_code: string | null; unit_code: string | null }>(
      `select e.id, e.question, e.status, ${VIETNAM_DAY('e.due_at')} as due_on, ${VIETNAM_DAY('e.original_due_at')} as original_due_on, p.code as project_code, u.code as unit_code
         from machvon.explanation_request e left join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id left join machvon.organization_unit u on u.tenant_id = e.tenant_id and u.id = e.unit_id
        where e.requested_from_membership_id = $1::uuid and e.status in ('REQUESTED', 'RETURNED', 'OVERDUE')
        order by e.due_at, e.id limit ${LIMIT}`,
      [input.membershipId],
    );
    return rows.map((row) => ({ id: row.id, kind: 'EXPLANATION' as WorkKind, dueOn: row.due_on, originalDueOn: row.original_due_on, title: row.question, subtitle: row.project_code ?? row.unit_code, status: row.status, target: { screen: 'PRJ-19', id: row.id } }));
  }

  /** The explanations that the person asked for and that were answered: they are the ones to conclude. */
  private async explanationsToConclude(tx: TenantTx, input: WorkInput): Promise<WorkRow[]> {
    const projects = input.projectScope(2);
    const units = input.unitScope(2 + projects.params.length);
    const rows = await tx.query<{ id: string; question: string; due_on: string; original_due_on: string; project_code: string | null; unit_code: string | null }>(
      `select e.id, e.question, ${VIETNAM_DAY('e.due_at')} as due_on, ${VIETNAM_DAY('e.original_due_at')} as original_due_on, p.code as project_code, u.code as unit_code
         from machvon.explanation_request e left join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id left join machvon.organization_unit u on u.tenant_id = e.tenant_id and u.id = e.unit_id
        where e.created_by = $1::uuid and e.requested_from_membership_id <> $1::uuid and e.status = 'RESPONDED'
          and ((e.project_id is not null and exists (select 1 from ${SCOPE_FROM} where p.id = e.project_id and ${projects.sql}))
               or (e.project_id is null and exists (select 1 from machvon.organization_unit u where u.tenant_id = e.tenant_id and u.id = e.unit_id and ${units.sql})))
        order by e.due_at, e.id limit ${LIMIT}`,
      [input.membershipId, ...projects.params, ...units.params],
    );
    return rows.map((row) => ({ id: row.id, kind: 'EXPLANATION_REVIEW' as WorkKind, dueOn: row.due_on, originalDueOn: row.original_due_on, title: row.question, subtitle: row.project_code ?? row.unit_code, status: 'RESPONDED', target: { screen: 'PRJ-19', id: row.id } }));
  }

  /** The reports of the person that came back, and the drafts whose period is past its deadline. */
  private async reports(tx: TenantTx, input: WorkInput): Promise<WorkRow[]> {
    const projects = input.projectScope(3);
    const rows = await tx.query<{ id: string; status: string; due_on: string; project_code: string; period_code: string }>(
      `select r.id, r.status, ${VIETNAM_DAY('rp.deadline_at')} as due_on, p.code as project_code, rp.code as period_code
         from machvon.report_revision r join ${SCOPE_FROM} on p.tenant_id = r.tenant_id and p.id = r.project_id join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where r.deleted_at is null and (r.created_by = $1::uuid or r.submitted_by = $1::uuid) and ${projects.sql}
          and not exists (select 1 from machvon.report_revision n where n.tenant_id = r.tenant_id and n.supersedes_id = r.id and n.deleted_at is null)
          and (r.status in ('RETURNED', 'AMENDMENT_REQUESTED') or (r.status = 'DRAFT' and rp.deadline_at < $2::timestamptz))
        order by rp.deadline_at, r.id limit ${LIMIT}`,
      [input.membershipId, input.now.toISOString(), ...projects.params],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: (row.status === 'DRAFT' ? 'REPORT_DRAFT_OVERDUE' : 'REPORT_RETURNED') as WorkKind,
      dueOn: row.due_on,
      originalDueOn: row.due_on,
      title: row.period_code,
      subtitle: row.project_code,
      status: row.status,
      target: { screen: 'DIS-03', id: row.id },
    }));
  }

  /**
   * The monitoring reports of the unit of the person (and the units under it) that are not handed in and are late or near their day, in the units they may read: their unit is where the work is, their right to read is
   * what lets them see it (a membership in a parent unit with a grant of one branch sees that branch only).
   */
  private async obligations(tx: TenantTx, input: WorkInput): Promise<WorkRow[]> {
    const visible = input.unitScope(3);
    const rows = await tx.query<{ id: string; status: string; due_date: string; period_label: string; unit_code: string | null; form_code: string | null }>(
      `select r.id, r.status, r.due_date::text as due_date, r.period_label, u.code as unit_code, f.form_code
         from machvon.membership m join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.organization_id
         join machvon.mne_report r on r.tenant_id = m.tenant_id
         join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.scope_unit_id and starts_with(u.path, mu.path)
         left join machvon.mne_report_form f on f.tenant_id = r.tenant_id and f.id = r.form_id
        where m.id = $1::uuid and r.revision = 1 and r.status in ('DRAFT', 'RETURNED') and r.due_date <= ($2::date + ${MNE_AHEAD_DAYS}) and ${visible.sql}
        order by r.due_date, r.id limit ${LIMIT}`,
      [input.membershipId, input.today, ...visible.params],
    );
    return rows.map((row) => ({ id: row.id, kind: 'MNE_OBLIGATION' as WorkKind, dueOn: row.due_date, originalDueOn: row.due_date, title: `${row.form_code ?? 'MNE'} ${row.period_label}`, subtitle: row.unit_code, status: row.status, target: { screen: 'MNE-03', id: row.id } }));
  }
}
