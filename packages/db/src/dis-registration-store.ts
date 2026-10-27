import { DomainError } from '@machvon/kernel';
import { CapScheduleStore } from './cap-schedule-store.ts';
import type { ScheduleRegistered } from './cap-schedule-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface RegistrationOutcome {
  skipped: 'NOT_FOUND' | 'NOT_ACCEPTED' | 'NEWER_REPORT' | 'FISCAL_YEAR_LOCKED' | 'PROJECT_STAGE_INVALID' | undefined;
  /** The cells that were left as they were because the registration in force came from a newer report. */
  superseded: number;
  /** The month the registration is for (the month after the period of the report), `YYYY-MM`. */
  month: string | null;
  registered: ScheduleRegistered[];
}

interface CellSql {
  bucket: 'CURRENT_YEAR' | 'CARRYOVER' | 'OTHER';
  budget_level: 'CENTRAL' | 'LOCAL';
  next_month: string;
  next_month_ctmtqg: string | null;
}

/** The statuses of a report whose amounts stand: accepted, or accepted and asked to be amended (it stays the current one until the correction is accepted, DisReportStore.decide). */
const REGISTERING_STATUSES: readonly string[] = ['ACCEPTED', 'AMENDMENT_REQUESTED'];

/** Everything of the tenant: the registration is made by the system for the project of an accepted report, not by a person in a scope. */
const WHOLE_TENANT: ScopeBuilder = () => ({ sql: 'true', params: [] });

/**
 * The registration for next month that an accepted report carries (ST-DIS-004, ST-DIS-017, DIS 3 F1; CAP task TK-CAP-009-2): when a report is accepted, the next-month amounts of its cells become the REGISTERED
 * rows of the month after the period, one for each source and budget level, each a new revision of the key that takes the place of the one before (CAP-009). A report that is not the accepted one any more (a
 * correction was accepted after it, which made it SUPERSEDED) registers nothing, and neither does a report whose registration is older than the one in force: a later week, or a later revision of the week, wins whatever the order of the deliveries. The report is read `for share` and held to the end of the transaction, so that the acceptance of a correction, which
 * supersedes it, waits for the registration or is seen by it: an old delivery cannot write the amounts of a superseded report over the ones of its correction. A cell with nothing is registered only when it replaces an amount that was registered before, so that a correction to nothing is not lost.
 */
export class DisRegistrationStore {
  private readonly schedules = new CapScheduleStore();

  async registerFromAcceptedReport(tx: TenantTx, reportId: string, actor: string, now: Date): Promise<RegistrationOutcome> {
    const none = (skipped: RegistrationOutcome['skipped'], month: string | null = null): RegistrationOutcome => ({ skipped, month, registered: [], superseded: 0 });
    const [report] = await tx.query<{ project_id: string; status: string; revision: number; end_date: string; next_month: string }>(
      `select r.project_id, r.status, r.revision, rp.end_date::text as end_date,
              to_char((date_trunc('month', rp.end_date::timestamp) + interval '1 month')::date, 'YYYY-MM') as next_month
         from machvon.report_revision r join machvon.reporting_period rp on rp.tenant_id = r.tenant_id and rp.id = r.period_id
        where r.id = $1::uuid and r.deleted_at is null
        for share of r`,
      [reportId],
    );
    if (report === undefined) return none('NOT_FOUND');
    if (!REGISTERING_STATUSES.includes(report.status)) return none('NOT_ACCEPTED');
    // One registration at a time for a project and a month, to the end of the transaction: the order of the weeks is judged and the rows are written under it, so that two deliveries of two weeks cannot each
    // see the other as not yet there (a zero of the later week is a row that is not written, and only this lock keeps the older week from writing past it).
    await tx.query("select pg_advisory_xact_lock(hashtextextended('dis_registration:' || current_setting('app.tenant_id') || ':' || $1::text || ':' || $2::text, 0))", [report.project_id, report.next_month]);
    // A later week of the same project that is accepted and registers for the same month is the one that stands, whatever it registered (even nothing) and whatever the order of the deliveries: the older
    // report leaves the month alone, so a zero of the later week is not undone by the late delivery of an older week.
    const [newer] = await tx.query<{ id: string }>(
      `select r2.id
         from machvon.report_revision r2 join machvon.reporting_period rp2 on rp2.tenant_id = r2.tenant_id and rp2.id = r2.period_id
        where r2.project_id = $1::uuid and r2.id <> $2::uuid and r2.status in ('ACCEPTED', 'AMENDMENT_REQUESTED') and r2.deleted_at is null
          and to_char((date_trunc('month', rp2.end_date::timestamp) + interval '1 month')::date, 'YYYY-MM') = $3
          and (rp2.end_date > $4::date or (rp2.end_date = $4::date and r2.revision > $5::integer))
        limit 1`,
      [report.project_id, reportId, report.next_month, report.end_date, report.revision],
    );
    if (newer !== undefined) return none('NEWER_REPORT', report.next_month);
    const [year, month] = report.next_month.split('-').map(Number) as [number, number];
    const cells = await tx.query<CellSql>(
      `select bucket, budget_level, next_month_registered_vnd::text as next_month, next_month_ctmtqg_subset_vnd::text as next_month_ctmtqg
         from machvon.funding_snapshot_line where report_revision_id = $1::uuid order by bucket, budget_level`,
      [reportId],
    );
    const registered: ScheduleRegistered[] = [];
    let superseded = 0;
    for (const cell of cells) {
      const earlier = await tx.query<{ n: string }>(
        `select count(*)::text as n from machvon.disbursement_schedule_line
          where project_id = $1::uuid and plan_year = $2::integer and granularity = 'MONTH' and month = $3::smallint and bucket = $4 and budget_level = $5 and kind = 'REGISTERED' and is_current`,
        [report.project_id, year, month, cell.bucket, cell.budget_level],
      );
      if (BigInt(cell.next_month) === 0n && Number(earlier[0]?.n ?? '0') === 0) continue;
      try {
        const made = await this.schedules.registerUnlessNewer(
            tx,
            {
              projectId: report.project_id,
              planYear: year,
              granularity: 'MONTH',
              month,
              kind: 'REGISTERED',
              bucket: cell.bucket,
              budgetLevel: cell.budget_level,
              amountVnd: cell.next_month,
              ...(cell.next_month_ctmtqg === null || cell.bucket === 'OTHER' ? {} : { ctmtqgSubsetVnd: cell.next_month_ctmtqg }),
              sourceReportRevisionId: reportId,
            },
            { endDate: report.end_date, revision: report.revision },
            actor,
            WHOLE_TENANT,
            now,
          );
        if (made === undefined) superseded += 1;
        else registered.push(made);
      } catch (error) {
        // A year that is closed takes no registration, and a project that no longer reports is not registered for: the acceptance stands, and the registration is told as skipped.
        if (error instanceof DomainError && (error.code === 'FISCAL_YEAR_LOCKED' || error.code === 'PROJECT_STAGE_INVALID')) return { ...none(error.code, report.next_month), registered, superseded };
        throw error;
      }
    }
    return { skipped: undefined, month: report.next_month, registered, superseded };
  }
}
