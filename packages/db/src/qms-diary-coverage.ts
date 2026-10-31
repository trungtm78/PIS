import { COVERAGE_CALENDAR, NOOP_METRICS, coverageRange, diaryCoverage } from '@machvon/kernel';
import type { Coverage, CoverageDiary, CoverageRange, MetricsSink } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

export const DIARY_MISSING_METRIC = 'qms_diary_missing_days';
const CALENDAR_YEARS_AHEAD = 1;

interface DiarySql {
  id: string;
  date: string;
  status: string;
  conflict: boolean;
  signed_on: string | null;
}

/**
 * The coverage of the site diary of a contract (ST-QMS-008, QMS 3.1, BR-QMS-08): the main diary of each day (a copy of a device is not a diary of the day; a diary stands until its correction is locked, and is not current after), whether a copy is
 * still unsettled, and the day, in Vietnamese time, on which the contractor first signed the diary of the day or a correction of it. The days are judged by the working calendar `WORKDAY_VN`.
 */
export class QmsDiaryCoverageReads {
  private readonly calendars = new WorkCalendarStore();

  async diaries(tx: TenantTx, contractId: string, from: string, through: string): Promise<CoverageDiary[]> {
    const rows = await tx.query<DiarySql>(
      `select d.id, d.record_date::text as date, d.status,
              exists (select 1 from machvon.site_diary k where k.tenant_id = d.tenant_id and k.conflict_state = 'CONFLICT_PENDING'
                        and k.conflict_of_id in (select x.id from machvon.site_diary x where x.tenant_id = d.tenant_id and x.contract_id = d.contract_id and x.record_date = d.record_date and x.conflict_of_id is null)) as conflict,
              (select ((min(s.signed_at)) at time zone 'Asia/Ho_Chi_Minh')::date::text
                 from machvon.qms_signature s
                where s.tenant_id = d.tenant_id and s.subject_kind = 'SITE_DIARY' and s.signer_role = 'CONTRACTOR'
                  and s.subject_id in (select x.id from machvon.site_diary x where x.tenant_id = d.tenant_id and x.contract_id = d.contract_id and x.record_date = d.record_date and x.conflict_of_id is null)) as signed_on
         from machvon.site_diary d
        where d.contract_id = $1::uuid and d.conflict_of_id is null and d.status <> 'SUPERSEDED' and (d.correction_of_id is null or d.status = 'LOCKED') and d.record_date between $2::date and $3::date
        order by d.record_date`,
      [contractId, from, through],
    );
    return rows.map((row) => ({ id: row.id, date: row.date, status: row.status, conflict: row.conflict, signedOn: row.signed_on ?? undefined }));
  }

  /** The coverage of a range of a contract; the contract is the caller's to have found. A year of the range without a published calendar is 422 `CALENDAR_NOT_EFFECTIVE`. */
  async coverage(tx: TenantTx, contractId: string, range: CoverageRange): Promise<Coverage> {
    if (range.through === undefined) return diaryCoverage(range, { forYear: () => undefined }, []);
    const diaries = await this.diaries(tx, contractId, range.from, range.through);
    // The calendars reach the year of the range and the one after it, and the year of the latest signature: how late a signature was is judged by the calendar of the days it spans.
    const signedYears = diaries.flatMap((diary) => (diary.signedOn === undefined ? [] : [Number(diary.signedOn.slice(0, 4))]));
    const toYear = Math.max(Number(range.through.slice(0, 4)) + CALENDAR_YEARS_AHEAD, ...signedYears);
    const calendars = await this.calendars.source(tx, COVERAGE_CALENDAR, Number(range.from.slice(0, 4)), toYear);
    return diaryCoverage(range, calendars, diaries);
  }
}

/**
 * The morning count of the diaries that are missing (QMS 3.1: `diary-coverage`, 06:00 Vietnamese time): for each contract in execution, the working days of the month up to yesterday that have no main diary, summed and
 * set as the gauge `qms_diary_missing_days` of the tenant. It changes nothing; the people who answer for a contract read the days on QMS-11.
 */
export class QmsDiaryCoverageJob {
  private readonly reads = new QmsDiaryCoverageReads();
  private readonly metrics: MetricsSink;

  constructor(metrics: MetricsSink = NOOP_METRICS) {
    this.metrics = metrics;
  }

  async run(tx: TenantTx, now: Date): Promise<{ contracts: number; missing: number }> {
    const tenantId = (await tx.query<{ tenant_id: string }>("select nullif(current_setting('app.tenant_id', true), '') as tenant_id"))[0]?.tenant_id ?? '';
    const yesterday = (await tx.query<{ day: string }>("select (($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date - 1)::text as day", [now.toISOString()]))[0]?.day ?? '';
    const contracts = await tx.query<{ id: string }>("select id from machvon.contract where status = 'ACTIVE' order by code, id");
    let missing = 0;
    for (const contract of contracts) {
      const coverage = await this.reads.coverage(tx, contract.id, coverageRange(`${yesterday.slice(0, 8)}01`, yesterday, yesterday));
      missing += coverage.totals.missing;
    }
    this.metrics.gauge(DIARY_MISSING_METRIC, missing, { tenant_id: tenantId });
    return { contracts: contracts.length, missing };
  }
}
