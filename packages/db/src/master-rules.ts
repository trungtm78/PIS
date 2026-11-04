import { DomainError, isLate, monthlyPeriods, periodOfType, reportingPeriods } from '@machvon/kernel';
import type { CalendarDefinition, ReportingPeriod } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** One reading of a rule: the version in force on the date, with everything a screen needs to say where the rule comes from. */
export interface RuleReading {
  ruleType: string;
  businessKey: string;
  /** The version that was read: a period or a record that is bound to it keeps reading exactly this one. */
  versionId: string;
  revision: number;
  validFrom: string;
  validUntil: string | null;
  legalBasis: string;
  ownerModule: string;
  /** The rule is a working assumption until the confirmation named by `cxn` arrives; a screen that applies it says so (it is awaiting signature). */
  awaitingConfirmation: boolean;
  cxn: string | null;
  attributes: Record<string, unknown>;
}

export interface NationalCodeRule {
  mode: 'BLOCK' | 'WARN';
  /** The stage of a project from which the national project code is required. */
  fromStageKey: string;
  /** The format of the code, when a format rule is in force; the code is checked against it before a stage is left. */
  format: { pattern: string; example: string } | null;
  reading: RuleReading;
}

/** A criterion of the set of appraisal criteria as the sheet scores it: the weight of the rule is its `max_score` (the weights add up to 100). */
export interface AppraisalCriterionRule {
  code: string;
  name: string;
  weight: string;
}

export interface AppraisalCriteriaSet {
  criteria: AppraisalCriterionRule[];
  /** The score from which the recommendation is ADMIT, as a decimal string. */
  passThreshold: string;
  reading: RuleReading;
}

export interface SuggestedGroup {
  groupKey: string;
  /** The sector whose table decided; null when the default table did. */
  sectorKey: string | null;
  reading: RuleReading;
}

interface RuleSqlRow {
  id: string;
  business_key: string;
  revision: number;
  valid_from: string;
  valid_until: string | null;
  legal_basis: string | null;
  attributes: Record<string, unknown>;
}

const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const DEFAULT_RULE_KEY = 'DEFAULT';

const cents = (amount: string): bigint => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

function reading(ruleType: string, row: RuleSqlRow): RuleReading {
  const { attributes } = row;
  return {
    ruleType,
    versionId: row.id,
    businessKey: row.business_key,
    revision: row.revision,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    legalBasis: row.legal_basis ?? '',
    ownerModule: typeof attributes.owner_module === 'string' ? attributes.owner_module : '',
    awaitingConfirmation: attributes.awaiting_confirmation === true,
    cxn: typeof attributes.cxn === 'string' ? attributes.cxn : null,
    attributes,
  };
}

function criteriaSetOf(found: RuleReading): AppraisalCriteriaSet {
  const list = Array.isArray(found.attributes.criteria) ? (found.attributes.criteria as Array<Record<string, unknown>>) : [];
  return {
    criteria: list.map((criterion) => ({ code: String(criterion.code), name: String(criterion.name ?? ''), weight: String(criterion.max_score) })),
    passThreshold: String(found.attributes.pass_threshold),
    reading: found,
  };
}

/** The reporting periods of a year from the calendar in force on a date, each bound to that version of the calendar. */
export interface CalendarPeriods {
  reading: RuleReading;
  periods: Array<ReportingPeriod & { calendarVersionId: string; calendarRevision: number }>;
}

/** What an open period remembers of the calendar it was generated from. */
export interface BoundPeriod {
  calendarVersionId: string;
  startsOn: string;
  /** The type of the period: its deadline is judged by it (a month is due on the 5th of the next one). A week when none is named. */
  periodType?: string;
}

const CALENDAR_KEY = 'DEFAULT';

function definitionOf(reading: RuleReading): CalendarDefinition {
  const { week_starts_on: weekStartsOn, deadline_weekday: deadlineWeekday, deadline_time: deadlineTime, timezone } = reading.attributes;
  return { weekStartsOn, deadlineWeekday, deadlineTime, timezone } as CalendarDefinition;
}

interface Band {
  sector_key: string | null;
  group_key: string;
  min_amount: string;
  max_amount: string | null;
}

/**
 * The port through which the modules read the legal rules that are kept as data (BR-MDM-09, ST-MDM-003): the rule is the version
 * that was in force on the business date, so a project proposed before a threshold changed is grouped by the old threshold. Nothing
 * here decides for the module; it returns the rule with its legal basis and whether it still waits for a confirmation.
 */
export class MasterRules {
  /** The rule of a type and key in force on `asOf`, or undefined when none is. The rules of the platform come before a tenant's own. */
  async read(tx: TenantTx, ruleType: string, businessKey: string, asOf: string): Promise<RuleReading | undefined> {
    const rows = await tx.query<RuleSqlRow>(
      `select v.id, r.business_key, v.revision, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.legal_basis, v.attributes
         from machvon.master_record r
         join machvon.master_record_version v on v.master_record_id = r.id
        where r.master_type = $1 and r.business_key = $2 and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and v.published_at is not null
          and v.valid_from <= $3::date and (v.valid_until is null or v.valid_until > $3::date)
        order by case r.namespace when 'PLATFORM' then 0 else 1 end, v.revision desc limit 1`,
      [ruleType, businessKey, asOf],
    );
    return rows[0] === undefined ? undefined : reading(ruleType, rows[0]);
  }

  /** Whether and from which stage the national project code is required, with the format it must have. */
  async nationalCode(tx: TenantTx, asOf: string): Promise<NationalCodeRule | undefined> {
    const required = await this.read(tx, 'NATIONAL_CODE_REQUIRED', DEFAULT_RULE_KEY, asOf);
    if (required === undefined) return undefined;
    const format = await this.read(tx, 'NATIONAL_CODE_FORMAT', DEFAULT_RULE_KEY, asOf);
    const { mode, from_stage_key: fromStageKey } = required.attributes;
    return {
      mode: mode === 'WARN' ? 'WARN' : 'BLOCK',
      fromStageKey: String(fromStageKey),
      format: format === undefined ? null : { pattern: String(format.attributes.pattern), example: String(format.attributes.example) },
      reading: required,
    };
  }

  /**
   * The group a project of this size falls in, by the table that was in force on the date it is proposed. The table of the sector
   * decides when it has one, the default table otherwise; the amount is a decimal string in VND and is compared exactly.
   */
  async suggestGroup(tx: TenantTx, request: { sectorKey?: string | undefined; totalInvestmentVnd: string }, asOf: string): Promise<SuggestedGroup | undefined> {
    if (!AMOUNT.test(request.totalInvestmentVnd)) throw new DomainError('VALIDATION_FAILED', 422, 'total_investment_vnd');
    const rule = await this.read(tx, 'PROJECT_GROUP_THRESHOLDS', DEFAULT_RULE_KEY, asOf);
    if (rule === undefined) return undefined;
    const bands = rule.attributes.bands as Band[];
    const amount = cents(request.totalInvestmentVnd);
    const own = request.sectorKey === undefined ? [] : bands.filter((band) => band.sector_key === request.sectorKey);
    const sectorKey = own.length > 0 ? (request.sectorKey ?? null) : null;
    const table = own.length > 0 ? own : bands.filter((band) => band.sector_key === null);
    // The edges are half open: an amount on an edge belongs to the band above it.
    const band = table.find((candidate) => cents(candidate.min_amount) <= amount && (candidate.max_amount === null || amount < cents(candidate.max_amount)));
    return band === undefined ? undefined : { groupKey: band.group_key, sectorKey, reading: rule };
  }

  /**
   * The set of appraisal criteria in force on a date (BR-PRJ-03, BR-PRJ-04): the platform's sets come before a tenant's own, and of those in
   * force the one that took effect last decides. Sheets are scored against the version they name, so a newer set never changes a sheet.
   */
  async appraisalCriteria(tx: TenantTx, asOf: string): Promise<AppraisalCriteriaSet | undefined> {
    const rows = await tx.query<RuleSqlRow>(
      `select v.id, r.business_key, v.revision, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.legal_basis, v.attributes
         from machvon.master_record r
         join machvon.master_record_version v on v.master_record_id = r.id
        where r.master_type = 'APPRAISAL_CRITERIA' and v.status in ('APPROVED', 'EFFECTIVE') and v.published_at is not null
          and v.valid_from <= $1::date and (v.valid_until is null or v.valid_until > $1::date)
        order by v.valid_from desc, case r.namespace when 'PLATFORM' then 0 else 1 end, v.revision desc limit 1`,
      [asOf],
    );
    return rows[0] === undefined ? undefined : criteriaSetOf(reading('APPRAISAL_CRITERIA', rows[0]));
  }

  /**
   * The regime of quality management that applies on a day (BR-QMS-04): the version of any regime in force on `asOf`, the platform's before a tenant's own and, of those in force, the one
   * that took effect last. Undefined when none is in force.
   */
  async regimeAt(tx: TenantTx, asOf: string): Promise<RuleReading | undefined> {
    const rows = await tx.query<RuleSqlRow>(
      `select v.id, r.business_key, v.revision, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.legal_basis, v.attributes
         from machvon.master_record r
         join machvon.master_record_version v on v.master_record_id = r.id
        where r.master_type = 'QMS_REGIME' and v.status in ('APPROVED', 'EFFECTIVE') and v.published_at is not null
          and v.valid_from <= $1::date and (v.valid_until is null or v.valid_until > $1::date)
        order by v.valid_from desc, case r.namespace when 'PLATFORM' then 0 else 1 end, v.revision desc limit 1`,
      [asOf],
    );
    return rows[0] === undefined ? undefined : reading('QMS_REGIME', rows[0]);
  }

  /** The set of appraisal criteria that a sheet names, whatever its dates. */
  async appraisalCriteriaVersion(tx: TenantTx, versionId: string): Promise<AppraisalCriteriaSet | undefined> {
    const found = await this.readVersion(tx, 'APPRAISAL_CRITERIA', versionId);
    return found === undefined ? undefined : criteriaSetOf(found);
  }

  /** Exactly one published version of a rule, whatever its dates: what a period or a record that was bound to it must keep reading. */
  async readVersion(tx: TenantTx, ruleType: string, versionId: string): Promise<RuleReading | undefined> {
    const rows = await tx.query<RuleSqlRow>(
      `select v.id, r.business_key, v.revision, v.valid_from::text as valid_from, v.valid_until::text as valid_until, v.legal_basis, v.attributes
         from machvon.master_record r
         join machvon.master_record_version v on v.master_record_id = r.id
        where r.master_type = $1 and v.id = $2::uuid and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and v.published_at is not null`,
      [ruleType, versionId],
    );
    return rows[0] === undefined ? undefined : reading(ruleType, rows[0]);
  }

  /**
   * The periods of a year that the reporting calendar in force on `asOf` produces (BR-MDM-08). Each period carries the version of the
   * calendar it came from: a module that stores the period stores that version with it, and judges lateness by it for ever after.
   */
  async calendarPeriods(tx: TenantTx, year: number, asOf: string, periodType = 'WEEK'): Promise<CalendarPeriods | undefined> {
    const rule = await this.read(tx, 'CALENDAR', CALENDAR_KEY, asOf);
    if (rule === undefined) return undefined;
    const periods = (periodType === 'MONTH' ? monthlyPeriods : reportingPeriods)(definitionOf(rule), year).map((period) => ({ ...period, calendarVersionId: rule.versionId, calendarRevision: rule.revision }));
    return { reading: rule, periods };
  }

  /**
   * The deadline of a period by the calendar version it was generated from, never by a newer one: publishing a new calendar changes the
   * periods that are generated after it and none that exist (no retroactive change).
   */
  async boundDeadline(tx: TenantTx, bound: BoundPeriod): Promise<string> {
    const rule = await this.readVersion(tx, 'CALENDAR', bound.calendarVersionId);
    if (rule === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'calendar_version_id');
    return periodOfType(definitionOf(rule), bound.periodType ?? 'WEEK', bound.startsOn).deadlineAt;
  }

  /** Whether a report handed in at `at` is late for a period, by the calendar version the period is bound to. */
  async isLate(tx: TenantTx, bound: BoundPeriod, at: Date): Promise<boolean> {
    return isLate({ deadlineAt: await this.boundDeadline(tx, bound) }, at);
  }
}
