import { DomainError, isWorkingDay, parseDueRule, periodicDueDate, reportPeriodOf, weeklyDueDate } from '@machvon/kernel';
import type { DueRule, WorkCalendarSource, WorkingDayTest } from '@machvon/kernel';
import { MasterRules } from './master-rules.ts';
import { MneFormStore } from './mne-form-store.ts';
import { MneObligationRuleStore, MNE_REPORTING_ROLES } from './mne-obligation-rule-store.ts';
import type { MneReportingRole, MneRuleRow } from './mne-obligation-rule-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

/** The columns of `organization_unit` that the scope of a caller is compiled over. */
export const MNE_UNIT_COLUMNS = { unitPath: 'u.path', unitId: 'u.id' } as const;

const OPEN_REVISION = 1;
/** Statuses whose lateness is settled by the filing, not by today. */
const SETTLED = ['SUBMITTED_EXTERNAL', 'SUPERSEDED'] as const;

/**
 * The units that owe a role, as the data model says them: an investor is a unit flagged as one, the owner agency is the owner unit of a
 * project, and the provincial people's committee is the governing body. Nothing in the model marks the planning agency, so that role
 * has no unit (it is reported back, never guessed).
 */
const ROLE_CONDITIONS: Readonly<Record<MneReportingRole, string | null>> = {
  INVESTOR: 'u.is_investor',
  PROJECT_OWNER_AGENCY: 'exists (select 1 from machvon.project p where p.tenant_id = u.tenant_id and p.owner_unit_id = u.id)',
  PROVINCIAL_PEOPLE_COMMITTEE: "u.unit_type = 'GOVERNING_BODY'",
  PLANNING_AGENCY: null,
};

export interface MneGenerateRequest {
  year: number;
  /** Narrows the run to one unit (which must lie in the scope of the caller). */
  scopeUnitId?: string | undefined;
  /** The Vietnam date of the run: it picks the reporting calendar in force for the weekly reports. */
  today: string;
  actor: string;
  scope: ScopeBuilder;
}

export interface MneGenerateResult {
  /** The obligations (report shells) this run wrote. */
  created: number;
  /** The obligations that existed already and were left as they were. */
  existing: number;
  /** The period and rule combinations the run looked at. */
  periods: number;
  /** Roles with a rule in force that no unit of the tenant holds: their obligations could not be written. */
  unresolvedRoles: MneReportingRole[];
}

export interface MneObligationFilter {
  reportYear?: number | undefined;
  scopeUnitId?: string | undefined;
  status?: string | undefined;
}

export interface MneObligationPage {
  limit: number;
  after?: { dueDate: string; id: string } | undefined;
}

/** One obligation of the calendar (MNE-01): a report shell with the rule revision and the form revision it was generated from. */
export interface MneObligationRow {
  id: string;
  obligationRuleId: string;
  ruleCode: string;
  ruleRevision: number;
  reportingRole: MneReportingRole;
  recipient: string;
  ruleLegalBasis: string;
  ruleLegalConfirmationRef: string | null;
  formId: string;
  formCode: string;
  formRevision: number;
  formTitle: string;
  formLegalConfirmationRef: string | null;
  reportYear: number;
  periodLabel: string;
  scopeUnitId: string;
  unitCode: string;
  unitName: string;
  dueDate: string;
  status: string;
  isLate: boolean;
  /** Days past the due date today (BR-MNE-04); null for a filed report whose filing day this table does not keep. */
  daysLate: number | null;
}

interface ObligationSql {
  id: string;
  obligation_rule_id: string;
  rule_code: string;
  rule_revision: number;
  reporting_role: MneReportingRole;
  recipient: string;
  rule_legal_basis: string;
  rule_legal_confirmation_ref: string | null;
  form_id: string;
  form_code: string;
  form_revision: number;
  form_title: string;
  form_legal_confirmation_ref: string | null;
  report_year: number;
  period_label: string;
  scope_unit_id: string;
  unit_code: string;
  unit_name: string;
  due_date: string;
  status: string;
  stored_is_late: boolean;
  open_days_late: number;
}

interface Candidate {
  rule: MneRuleRow;
  label: string;
  endsOn: string;
  dueDate: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const inForce = (rule: MneRuleRow, on: string): boolean => rule.effectiveFrom <= on && (rule.effectiveUntil === null || on < rule.effectiveUntil);

const toObligation = (row: ObligationSql): MneObligationRow => {
  const settled = (SETTLED as readonly string[]).includes(row.status);
  return {
    id: row.id,
    obligationRuleId: row.obligation_rule_id,
    ruleCode: row.rule_code,
    ruleRevision: row.rule_revision,
    reportingRole: row.reporting_role,
    recipient: row.recipient,
    ruleLegalBasis: row.rule_legal_basis,
    ruleLegalConfirmationRef: row.rule_legal_confirmation_ref,
    formId: row.form_id,
    formCode: row.form_code,
    formRevision: row.form_revision,
    formTitle: row.form_title,
    formLegalConfirmationRef: row.form_legal_confirmation_ref,
    reportYear: row.report_year,
    periodLabel: row.period_label,
    scopeUnitId: row.scope_unit_id,
    unitCode: row.unit_code,
    unitName: row.unit_name,
    dueDate: row.due_date,
    status: row.status,
    isLate: settled ? row.stored_is_late : row.open_days_late > 0,
    daysLate: settled ? (row.stored_is_late ? null : 0) : row.open_days_late,
  };
};

/**
 * The filing calendar (ST-MNE-001, MNE F2, BR-MNE-02, BR-MNE-03): the obligations of a year are DRAFT report shells, one for every
 * unit that owes a role, every rule in force at the end of the period and every period. The deadline is the formula of the rule in force
 * on the last day of the period, and the form is the revision in force on that day. A run writes only what is missing, so running it
 * again adds nothing; the unique index of the report is the last word when two runs race.
 */
export class MneObligationStore {
  private readonly forms = new MneFormStore();
  private readonly rules = new MneObligationRuleStore();
  private readonly calendars = new MasterRules();
  private readonly workCalendars = new WorkCalendarStore();

  async generate(tx: TenantTx, request: MneGenerateRequest): Promise<MneGenerateResult> {
    if (!Number.isInteger(request.year) || request.year < 2000 || request.year > 2999) throw invalid('report_year');
    const candidates = await this.candidates(tx, request.year, request.today);
    if (candidates.length === 0) throw new DomainError('NO_EFFECTIVE_RULE', 422, 'report_year');
    const predicate = request.scope(1);
    if (request.scopeUnitId !== undefined) await this.assertUnitInScope(tx, request.scopeUnitId, predicate);
    const unitsByRole = new Map<MneReportingRole, string[]>();
    const unresolved = new Set<MneReportingRole>();
    const result: MneGenerateResult = { created: 0, existing: 0, periods: candidates.length, unresolvedRoles: [] };
    for (const candidate of candidates) {
      const role = candidate.rule.reportingRole;
      if (!unitsByRole.has(role)) unitsByRole.set(role, await this.unitsOf(tx, role, predicate, request.scopeUnitId));
      const units = unitsByRole.get(role) ?? [];
      if (ROLE_CONDITIONS[role] === null) unresolved.add(role);
      if (units.length === 0) continue;
      const form = await this.forms.inForce(tx, candidate.rule.formCode, candidate.endsOn);
      if (form === undefined) throw new DomainError('FORM_NOT_EFFECTIVE', 422, 'form_code');
      const written = await this.write(tx, { form: form.id, rule: candidate.rule.id, year: request.year, candidate, units, actor: request.actor });
      result.created += written;
      result.existing += units.length - written;
    }
    result.unresolvedRoles = MNE_REPORTING_ROLES.filter((role) => unresolved.has(role));
    return result;
  }

  /** The obligations of the calendar in the scope of the caller, by due date. */
  async list(tx: TenantTx, filter: MneObligationFilter, page: MneObligationPage, scope: ScopeBuilder, today: string): Promise<MneObligationRow[]> {
    const predicate = scope(8);
    const rows = await tx.query<ObligationSql>(
      `select r.id, r.obligation_rule_id, o.rule_code, o.revision as rule_revision, o.reporting_role, o.recipient, o.legal_basis as rule_legal_basis,
              o.legal_confirmation_ref as rule_legal_confirmation_ref, r.form_id, f.form_code, f.revision as form_revision, f.title as form_title,
              f.legal_confirmation_ref as form_legal_confirmation_ref, r.report_year, r.period_label, r.scope_unit_id, u.code as unit_code, u.name as unit_name,
              r.due_date::text as due_date, r.status, r.is_late as stored_is_late, greatest(0, $1::date - r.due_date) as open_days_late
         from machvon.mne_report r
         join machvon.mne_obligation_rule o on o.tenant_id = r.tenant_id and o.id = r.obligation_rule_id
         join machvon.mne_report_form f on f.tenant_id = r.tenant_id and f.id = r.form_id
         join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.scope_unit_id
        where ($2::int is null or r.report_year = $2::int) and ($3::uuid is null or r.scope_unit_id = $3::uuid) and ($4::text is null or r.status = $4)
          and ($5::date is null or (r.due_date, r.id) > ($5::date, $6::uuid)) and ${predicate.sql}
        order by r.due_date, r.id limit $7`,
      [today, filter.reportYear ?? null, filter.scopeUnitId ?? null, filter.status ?? null, page.after?.dueDate ?? null, page.after?.id ?? null, page.limit, ...predicate.params],
    );
    return rows.map(toObligation);
  }

  /**
   * The deadline that a rule gives the report of a period (the label of the period in the year), as the calendar would have written it, and the code of the form the rule asks for; undefined when the rule is not
   * in force at the end of that period or asks nothing of it. Only that rule is evaluated: the calendar or the working days of another rule cannot stop it.
   */
  async dueDateFor(tx: TenantTx, ruleId: string, label: string, year: number, today: string): Promise<{ dueDate: string; formCode: string } | undefined> {
    const found = (await this.candidates(tx, year, today, ruleId)).find((candidate) => candidate.label === label);
    return found === undefined ? undefined : { dueDate: found.dueDate, formCode: found.rule.formCode };
  }

  /** The rules in force at the end of each period of the year, with the period and the deadline each one gives. */
  private async candidates(tx: TenantTx, year: number, today: string, onlyRuleId?: string): Promise<Candidate[]> {
    const rows = (await this.rules.inWindow(tx, { from: `${year}-01-01`, until: `${year + 1}-01-01` })).filter((rule) => onlyRuleId === undefined || rule.id === onlyRuleId);
    if (rows.length === 0) return [];
    const parsed = rows.map((rule) => ({ rule, due: parseDueRule(rule.frequency, rule.dueRuleJson) }));
    const working = await this.workingTest(tx, parsed.map((entry) => entry.due), year);
    const weeks = parsed.some((entry) => entry.due.frequency === 'WEEKLY') ? await this.weeks(tx, year, today) : [];
    const found: Candidate[] = [];
    for (const { rule, due } of parsed) found.push(...this.periodsOf(rule, due, year, weeks, working));
    return found.sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.rule.ruleCode.localeCompare(right.rule.ruleCode) || left.label.localeCompare(right.label));
  }

  /** The periods of the year that a rule asks a report for. An EVENT rule has no period: it waits for the event of a project. */
  private periodsOf(rule: MneRuleRow, due: DueRule, year: number, weeks: ReadonlyArray<{ code: string; startsOn: string; endsOn: string }>, working: WorkingDayTest): Candidate[] {
    switch (due.frequency) {
      case 'EVENT':
        return [];
      case 'WEEKLY':
        return weeks
          .filter((week) => inForce(rule, week.endsOn))
          .map((week) => ({ rule, label: week.code, endsOn: week.endsOn, dueDate: weeklyDueDate(due, week.startsOn, working) }));
      default: {
        const period = reportPeriodOf(due, year);
        return inForce(rule, period.endsOn) ? [{ rule, label: period.label, endsOn: period.endsOn, dueDate: periodicDueDate(due, year, working) }] : [];
      }
    }
  }

  /** The weeks of the year by the reporting calendar in force today (MDM, BR-MDM-08); weekly rules need one. */
  private async weeks(tx: TenantTx, year: number, today: string): Promise<Array<{ code: string; startsOn: string; endsOn: string }>> {
    const calendar = await this.calendars.calendarPeriods(tx, year, today);
    if (calendar === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar');
    return calendar.periods.map((period) => ({ code: period.code, startsOn: period.startsOn, endsOn: period.endsOn }));
  }

  /** The working-day test of the rules that shift their deadline: each reads the published working calendar it names. */
  private async workingTest(tx: TenantTx, rules: readonly DueRule[], year: number): Promise<WorkingDayTest> {
    const sources = new Map<string, WorkCalendarSource>();
    for (const rule of rules) {
      if (rule.calendarCode !== null && !sources.has(rule.calendarCode)) sources.set(rule.calendarCode, await this.workCalendars.source(tx, rule.calendarCode, year));
    }
    return (calendarCode, date) => {
      const content = sources.get(calendarCode)?.forYear(Number(date.slice(0, 4)));
      if (content === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
      return isWorkingDay(content, date);
    };
  }

  private async unitsOf(tx: TenantTx, role: MneReportingRole, predicate: { sql: string; params: unknown[] }, scopeUnitId: string | undefined): Promise<string[]> {
    const condition = ROLE_CONDITIONS[role];
    if (condition === null) return [];
    const unitParam = predicate.params.length + 1;
    const rows = await tx.query<{ id: string }>(
      `select u.id from machvon.organization_unit u
        where u.status = 'Active' and ${condition} and ${predicate.sql} and ($${unitParam}::uuid is null or u.id = $${unitParam}::uuid)
        order by u.id`,
      [...predicate.params, scopeUnitId ?? null],
    );
    return rows.map((row) => row.id);
  }

  private async assertUnitInScope(tx: TenantTx, unitId: string, predicate: { sql: string; params: unknown[] }): Promise<void> {
    const known = await tx.query('select 1 from machvon.organization_unit u where u.id = $1::uuid', [unitId]);
    // A unit of another tenant is indistinguishable from one that does not exist.
    if (known.length === 0) throw invalid('scope_unit_id');
    const inScope = await tx.query(`select 1 from machvon.organization_unit u where u.id = $${predicate.params.length + 1}::uuid and ${predicate.sql}`, [...predicate.params, unitId]);
    if (inScope.length === 0) throw new DomainError('SCOPE_DENIED', 403);
  }

  /** Writes the shells that are missing for one period and returns how many it wrote. */
  private async write(tx: TenantTx, shell: { form: string; rule: string; year: number; candidate: Candidate; units: readonly string[]; actor: string }): Promise<number> {
    const rows = await tx.query<{ scope_unit_id: string }>(
      `insert into machvon.mne_report
         (tenant_id, id, form_id, obligation_rule_id, report_year, period_label, scope_unit_id, due_date, revision, status, payload_json, created_by, updated_by)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::int, $4, unit, $5::date, ${OPEN_REVISION}, 'DRAFT', '{}'::jsonb, $6::uuid, $6::uuid
         from unnest($7::uuid[]) as unit
       on conflict do nothing
       returning scope_unit_id`,
      [shell.form, shell.rule, shell.year, shell.candidate.label, shell.candidate.dueDate, shell.actor, [...shell.units]],
    );
    return rows.length;
  }
}
