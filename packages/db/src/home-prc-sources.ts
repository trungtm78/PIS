import { WORKFLOW_DEFAULT_STALLED_DAYS, isStalled } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { Params, SOURCE_LIMIT, addDays, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

const JOINS = `from machvon.package_workflow w
  join machvon.procurement_package k on k.tenant_id = w.tenant_id and k.id = w.package_id
  left join machvon.project p on p.tenant_id = k.tenant_id and p.id = k.project_id
  left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  join machvon.package_step s on s.tenant_id = w.tenant_id and s.workflow_id = w.id and s.exited_at is null`;

/**
 * The monitoring of the procurement workflow as a source of the alert centre (PRC-1, docs/bid-workflow.md). Four kinds, each with an ALERT_TYPE (owner, expected action, consequence) in the governance registry:
 *  - `PRC_STEP_OVERDUE`: a package that is IN_PROGRESS and whose step is past its due day (a package on hold is not late: the clock is extended when it resumes). Owner: the package owner. Expected action: finish the open items and move
 *    the package on, or ask for an exception with a reason. Consequence: the steps after it and the contract date move back.
 *  - `PRC_CHECKLIST_DUE`: a required item of the current step that is past its day (ACTION) or within the warning days of the definition (WATCH). Owner: the owner of the item, else the owner of the package.
 *  - `PRC_PACKAGE_STALLED`: a package with no activity for the working days its definition allows (counted on the published working calendar; with no calendar nothing is said, never a guessed number).
 *  - `PRC_NO_OWNER`: a package under way that nobody answers for.
 * An item that a milestone of the package already completes (the dates of BID-17 and the file of the national network) is not an open item, so it raises nothing.
 */
export class HomePrcSources {
  private readonly calendars: HomeWorkCalendars;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  async items(context: SourceContext): Promise<SourceRow[]> {
    const [overdue, checklist, stalled, ownerless] = [await this.stepsOverdue(context), await this.checklists(context), await this.stalled(context), await this.noOwner(context)];
    return [...overdue, ...checklist, ...stalled, ...ownerless];
  }

  private async stepsOverdue(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'PROCUREMENT_WORKFLOW', id: `(w.id::text || ':step')`, tenant: 'w', responsible: ['w.owner_membership_id'], unit: false });
    const rows = await context.tx.query<{ id: string; package_id: string; package_code: string; step_code: string; due_on: string; entered_on: string; project_code: string | null; owner: string | null }>(
      `select w.id::text || ':step' as id, k.id as package_id, k.code as package_code, s.step_code, s.due_on::text as due_on, s.entered_on::text as entered_on, p.code as project_code, w.owner_membership_id as owner
         ${JOINS}
        where w.status = 'IN_PROGRESS' and s.due_on < ${today}::date and ${visible}
        order by s.due_on, w.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row) => ({
      ...base('PRC_STEP_OVERDUE'),
      id: row.id,
      dueOn: row.due_on,
      originalDueOn: row.due_on,
      title: `Gói thầu ${row.package_code} quá hạn bước ${row.step_code}`,
      subtitle: label(row.project_code, `Hạn bước ${row.due_on}`),
      status: 'OVERDUE',
      severity: severityOf('PROCUREMENT_WORKFLOW', 'STEP_OVERDUE', context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES.PRC_STEP_OVERDUE ?? null,
      causeKey: `prc:${row.package_id}`,
      startedAt: startOfDay(addDays(row.due_on, 1)),
      target: { screen: 'BID-29', id: row.package_id },
    }));
  }

  private async checklists(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'PROCUREMENT_WORKFLOW', id: 'i.id', tenant: 'w', responsible: ['i.owner_membership_id', 'w.owner_membership_id'], unit: false });
    const rows = await context.tx.query<{ id: string; package_id: string; package_code: string; item_code: string; name: string; due_on: string; warn_days: number; project_code: string | null }>(
      `select i.id, k.id as package_id, k.code as package_code, i.item_code, i.name, i.due_on::text as due_on, coalesce((w.definition ->> 'checklist_warn_days')::int, 2) as warn_days, p.code as project_code
         ${JOINS}
         join machvon.package_checklist_item i on i.tenant_id = w.tenant_id and i.step_visit_id = s.id and i.status = 'OPEN' and i.required and i.due_on is not null
        where w.status = 'IN_PROGRESS' and ${visible}
          and not exists (select 1 from machvon.procurement_milestone m where m.tenant_id = i.tenant_id and m.package_id = i.package_id and m.milestone_kind = i.milestone_kind and m.actual_at is not null)
          and i.due_on <= ${today}::date + coalesce((w.definition ->> 'checklist_warn_days')::int, 2)
        order by i.due_on, i.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row) => {
      const late = row.due_on < context.today;
      return {
        ...base('PRC_CHECKLIST_DUE'),
        id: row.id,
        dueOn: row.due_on,
        originalDueOn: row.due_on,
        title: late ? `Mục bắt buộc quá hạn · ${row.package_code}` : `Mục bắt buộc sắp đến hạn · ${row.package_code}`,
        subtitle: label(row.project_code, row.name),
        status: late ? 'OVERDUE' : 'DUE_SOON',
        severity: severityOf('PROCUREMENT_WORKFLOW', late ? 'CHECKLIST_OVERDUE' : 'CHECKLIST_DUE_SOON', context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES.PRC_CHECKLIST_DUE ?? null,
        causeKey: `prc:${row.package_id}`,
        startedAt: late ? startOfDay(addDays(row.due_on, 1)) : null,
        target: { screen: 'BID-29', id: row.package_id },
      } satisfies SourceRow;
    });
  }

  private async stalled(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'PROCUREMENT_WORKFLOW', id: `(w.id::text || ':stalled')`, tenant: 'w', responsible: ['w.owner_membership_id'], unit: false });
    // Working days never exceed calendar days, so a package that is stalled in working days is at least that many calendar days quiet: the read narrows by calendar days and the count refines by working days.
    const rows = await context.tx.query<{ id: string; workflow_id: string; package_id: string; package_code: string; last_activity_on: string; stalled_days: number; project_code: string | null }>(
      `select w.id::text || ':stalled' as id, w.id as workflow_id, k.id as package_id, k.code as package_code, w.last_activity_on::text as last_activity_on,
              coalesce((w.definition ->> 'stalled_after_working_days')::int, ${WORKFLOW_DEFAULT_STALLED_DAYS}) as stalled_days, p.code as project_code
         ${JOINS}
        where w.status in ('IN_PROGRESS', 'ON_HOLD') and w.last_activity_on <= ${today}::date - coalesce((w.definition ->> 'stalled_after_working_days')::int, ${WORKFLOW_DEFAULT_STALLED_DAYS}) and ${visible}
        order by w.last_activity_on, w.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    if (rows.length === 0) return [];
    const calendars = await this.calendars.load(context.tx, WORK_CALENDAR_CODE, context.now);
    const items: SourceRow[] = [];
    for (const row of rows) {
      if (isStalled(calendars, row.last_activity_on, context.today, Number(row.stalled_days)) !== true) continue;
      items.push({
        ...base('PRC_PACKAGE_STALLED'),
        id: row.id,
        dueOn: context.today,
        originalDueOn: context.today,
        title: `Gói thầu ${row.package_code} đứng yên từ ${row.last_activity_on}`,
        subtitle: label(row.project_code, `Không có biến động quá ${row.stalled_days} ngày làm việc`),
        status: 'STALLED',
        severity: severityOf('PROCUREMENT_WORKFLOW', 'PACKAGE_STALLED', context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES.PRC_PACKAGE_STALLED ?? null,
        causeKey: `prc:${row.package_id}`,
        startedAt: startOfDay(row.last_activity_on),
        target: { screen: 'BID-29', id: row.package_id },
      });
    }
    return items;
  }

  private async noOwner(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = reach(params, context, { source: 'PROCUREMENT_WORKFLOW', id: `(w.id::text || ':owner')`, tenant: 'w', responsible: [], unit: false });
    const rows = await context.tx.query<{ id: string; package_id: string; package_code: string; started_on: string; project_code: string | null }>(
      `select w.id::text || ':owner' as id, k.id as package_id, k.code as package_code, ((w.started_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as started_on, p.code as project_code
         ${JOINS}
        where w.status in ('IN_PROGRESS', 'ON_HOLD') and w.owner_membership_id is null and ${visible}
        order by w.started_at, w.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row) => ({
      ...base('PRC_NO_OWNER'),
      id: row.id,
      dueOn: context.today,
      originalDueOn: row.started_on,
      title: `Gói thầu ${row.package_code} chưa có người phụ trách`,
      subtitle: label(row.project_code, `Bắt đầu quy trình ${row.started_on}`),
      status: 'NO_OWNER',
      severity: severityOf('PROCUREMENT_WORKFLOW', 'NO_OWNER', context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES.PRC_NO_OWNER ?? null,
      causeKey: `prc:${row.package_id}`,
      startedAt: startOfDay(row.started_on),
      target: { screen: 'BID-29', id: row.package_id },
    }));
  }
}

