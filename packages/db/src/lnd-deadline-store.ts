import { daysBetween } from '@machvon/kernel';
import type { LandTimerCode } from '@machvon/kernel';
import { enterScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export type DeadlineSubject = 'PARCEL' | 'PLAN' | 'PAYMENT' | 'COMPLAINT';
export type DeadlineState = 'RUNNING' | 'SATISFIED' | 'BREACHED' | 'CANCELLED';

/** A timer of land clearance as the list of what is coming up reads it: what it counts by its code (never by a person), the days left and the rule it was counted by. */
export interface UpcomingDeadline {
  id: string;
  projectId: string;
  subjectKind: DeadlineSubject;
  subjectId: string;
  /** The code of what the timer counts (a parcel, a plan with its revision, a payment of a plan); null when the caller does not see it. */
  subjectLabel: string | null;
  timerCode: LandTimerCode;
  daysApplied: number;
  startedOn: string;
  dueOn: string;
  remainingDays: number;
  status: DeadlineState;
  alertLevelSent: number;
  legalBasis: string | null;
  awaitingConfirmation: boolean;
  cxn: string | null;
}

export interface UpcomingFilter {
  withinDays: number;
  today: string;
  limit: number;
  after?: { dueOn: string; id: string } | undefined;
}

/**
 * The timers of land clearance that are about to fall due or have been breached (LND-07, LND-11, `listUpcomingLandDeadlines`): the running ones that fall due within the days asked, those that are already past and
 * the breached ones of the last days asked, the soonest first. A timer is in the list when the caller reaches the project it belongs to; what it counts is named by its code only, and a payment is named
 * inside the units of its household.
 */
export class LndDeadlineStore {
  async upcoming(tx: TenantTx, scope: ScopeBuilder, units: ScopeUnits, filter: UpcomingFilter): Promise<UpcomingDeadline[]> {
    await enterScope(tx, units);
    const predicate = scope(6);
    const rows = await tx.query<{
      id: string;
      project_id: string;
      subject_kind: DeadlineSubject;
      subject_id: string;
      subject_label: string | null;
      timer_code: LandTimerCode;
      days_applied: number;
      started_on: string;
      due_on: string;
      status: DeadlineState;
      alert_level_sent: number;
      legal_basis: string | null;
      awaiting: boolean;
      cxn: string | null;
    }>(
      `select dl.id, dl.project_id, dl.subject_kind, dl.subject_id,
              case dl.subject_kind
                when 'PARCEL' then pc.parcel_code
                when 'PLAN' then pl.plan_code || ' / ' || pl.revision::text
                when 'PAYMENT' then ppl.plan_code || ' / ' || ppl.revision::text || ' #' || cp.payment_no::text
              end as subject_label,
              dl.timer_code, dl.days_applied, dl.started_on::text as started_on, dl.due_on::text as due_on, dl.status, dl.alert_level_sent, rv.legal_basis,
              coalesce((rv.attributes ->> 'awaiting_confirmation')::boolean, false) as awaiting, rv.attributes ->> 'cxn' as cxn
         from machvon.land_deadline dl
         join machvon.project p on p.tenant_id = dl.tenant_id and p.id = dl.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
         left join machvon.land_parcel pc on dl.subject_kind = 'PARCEL' and pc.tenant_id = dl.tenant_id and pc.id = dl.subject_id
         left join machvon.compensation_plan pl on dl.subject_kind = 'PLAN' and pl.tenant_id = dl.tenant_id and pl.id = dl.subject_id
         left join machvon.compensation_payment cp on dl.subject_kind = 'PAYMENT' and cp.tenant_id = dl.tenant_id and cp.id = dl.subject_id
         left join machvon.compensation_plan ppl on ppl.tenant_id = cp.tenant_id and ppl.id = cp.plan_id
         left join machvon.master_record_version rv on rv.tenant_id = dl.tenant_id and rv.id = dl.rule_version_id
        where dl.due_on <= $1::date + $2::int
          and (dl.status = 'RUNNING' or (dl.status = 'BREACHED' and dl.due_on >= $1::date - $2::int))
          and ($3::date is null or (dl.due_on, dl.id) > ($3::date, $4::uuid))
          and ${predicate.sql}
        order by dl.due_on, dl.id
        limit $5`,
      [filter.today, filter.withinDays, filter.after?.dueOn ?? null, filter.after?.id ?? null, filter.limit, ...predicate.params],
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      subjectLabel: row.subject_label,
      timerCode: row.timer_code,
      daysApplied: row.days_applied,
      startedOn: row.started_on,
      dueOn: row.due_on,
      remainingDays: daysBetween(filter.today, row.due_on),
      status: row.status,
      alertLevelSent: row.alert_level_sent,
      legalBasis: row.legal_basis,
      awaitingConfirmation: row.awaiting,
      cxn: row.cxn,
    }));
  }
}
