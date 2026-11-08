import type { Translator } from '../../i18n';
import type { Tone } from '../../ui';
import { camelOf } from './ind-model';
import type { ApplyBlock, Category, Origin, Outcome, Problem, RowStatus, Surface, ValueKind } from './ind-model';

type T = Translator['t'];

export const categoryLabel = (t: T, category: Category): string => t(`ind.category.${camelOf(category)}.label`);
export const valueKindLabel = (t: T, kind: ValueKind): string => t(`ind.valueKind.${camelOf(kind)}.label`);
export const surfaceLabel = (t: T, surface: Surface): string => t(`ind.surface.${camelOf(surface)}.label`);
export const severityLabel = (t: T, severity: 'BLOCK' | 'WARN'): string => t(`ind.severity.${camelOf(severity)}.label`);
export const severityTone = (severity: 'BLOCK' | 'WARN'): Tone => (severity === 'BLOCK' ? 'danger' : 'warning');
export const layoutLabel = (t: T, layout: 'COLUMNS' | 'ROWS'): string => t(`ind.layout.${camelOf(layout)}.label`);
export const numberFormatLabel = (t: T, format: 'PLAIN' | 'VN'): string => t(`ind.numberFormat.${camelOf(format)}.label`);
export const rowStatusLabel = (t: T, status: RowStatus): string => t(`ind.rowStatus.${camelOf(status)}.label`);
export const rowStatusTone = (status: RowStatus): Tone => (status === 'VALID' ? 'success' : status === 'ERROR' ? 'danger' : status === 'CONFLICT' ? 'warning' : 'neutral');
export const outcomeLabel = (t: T, outcome: Outcome): string => t(`ind.outcome.${camelOf(outcome)}.label`);

const KNOWN = {
  unit: ['PERCENT', 'VND', 'COUNT', 'DAYS', 'RATIO'],
  period: ['YEAR_TO_DATE', 'AS_OF_NOW', 'WEEK', 'MONTH', 'QUARTER'],
  scale: ['ONE', 'THOUSAND', 'MILLION', 'BILLION'],
  vat: ['EXCLUDING_VAT', 'INCLUDING_VAT', 'NOT_APPLICABLE'],
  check: ['CUMULATIVE_NOT_ABOVE_TOTAL', 'PARTS_EQUAL_TOTAL', 'PERIOD_LOCKED_AFTER_CLOSE', 'FIELD_REQUIRED', 'VALUE_IN_RANGE'],
  versionStatus: ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETIRED'],
  periodStatus: ['OPEN', 'SOFT_CLOSED', 'LOCKED', 'REOPENED'],
  finding: ['ENTRY_FIELD_SHARED', 'ALIAS_SHARED', 'ENTERED_WITHOUT_FIELD', 'DERIVED_WITH_FIELD'],
  mappingProblem: ['INDICATOR_UNKNOWN', 'INDICATOR_NOT_ENTERABLE'],
  skip: ['OTHER_SURFACE', 'FACT_MISSING'],
  rowCode: [
    'PROJECT_MISSING',
    'PERIOD_MISSING',
    'PROJECT_UNKNOWN',
    'PERIOD_UNKNOWN',
    'PERIOD_AMBIGUOUS',
    'PERIOD_LOCKED',
    'PROJECT_MISMATCH',
    'PERIOD_MISMATCH',
    'VALUE_REQUIRED',
    'NUMBER_INVALID',
    'NUMBER_TOO_PRECISE',
    'NUMBER_NOT_WHOLE',
    'ROW_EMPTY',
    'LABEL_UNMAPPED',
    'INDICATOR_UNKNOWN',
    'INDICATOR_NOT_ENTERABLE',
    'ENTRY_RULE_BLOCKED',
    'DUPLICATE_CONFLICT',
    'BUSINESS_KEY_INVALID',
    'MEASURE_INVALID',
  ],
  difference: ['IND_FIGURE_DIFFERS', 'DUPLICATE_CONFLICT'],
} as const;

const known = (list: readonly string[], value: string): boolean => list.includes(value);

export const unitLabel = (t: T, unit: string): string => (known(KNOWN.unit, unit) ? t(`ind.unit.${camelOf(unit)}.label`) : unit);
export const periodLabel = (t: T, period: string): string => (known(KNOWN.period, period) ? t(`ind.period.${camelOf(period)}.label`) : period);
export const scaleLabel = (t: T, scale: string): string => (known(KNOWN.scale, scale) ? t(`ind.scale.${camelOf(scale)}.label`) : scale);
export const vatLabel = (t: T, vat: string | null): string => (vat === null ? t('ind.vat.unset.label') : known(KNOWN.vat, vat) ? t(`ind.vat.${camelOf(vat)}.label`) : vat);
export const checkLabel = (t: T, check: string): string => (known(KNOWN.check, check) ? t(`ind.check.${camelOf(check)}.label`) : check);
export const versionStatusLabel = (t: T, status: string): string => (known(KNOWN.versionStatus, status) ? t(`ind.versionStatus.${camelOf(status)}.label`) : status);
export const periodStatusLabel = (t: T, status: string): string => (known(KNOWN.periodStatus, status) ? t(`ind.periodStatus.${camelOf(status)}.label`) : status);
export const findingLabel = (t: T, code: string, detail: string): string => (known(KNOWN.finding, code) ? t(`ind.finding.${camelOf(code)}.label`, { detail }) : code);
export const mappingProblemLabel = (t: T, code: string, indicator: string): string => (known(KNOWN.mappingProblem, code) ? t(`ind.mappingProblem.${camelOf(code)}.label`, { indicator }) : code);
export const skipLabel = (t: T, reason: string): string => (known(KNOWN.skip, reason) ? t(`ind.skip.${camelOf(reason)}.label`) : reason);
export const rowCodeLabel = (t: T, code: string): string => (known(KNOWN.rowCode, code) ? t(`ind.rowCode.${camelOf(code)}.label`) : t('ind.rowCode.other.label', { code }));
export const differenceLabel = (t: T, code: string): string => (known(KNOWN.difference, code) ? t(`ind.difference.${camelOf(code)}.label`) : t('ind.difference.other.label', { code }));

/** Where a definition stands: the starting value of the platform that nobody confirmed, or a version the tenant approved. */
export const originLabel = (t: T, origin: Origin, unverified: boolean): string => (origin === 'RULE' ? t('ind.origin.rule.label') : unverified ? t('ind.origin.defaultUnverified.label') : t('ind.origin.default.label'));

export function applyBlockLabel(t: T, block: ApplyBlock): string {
  switch (block) {
    case 'noPreview':
      return t('ind.imp.block.noPreview');
    case 'noValid':
      return t('ind.imp.block.noValid');
    case 'alreadyApplied':
      return t('ind.imp.block.alreadyApplied');
    case 'noAuthority':
      return t('ind.imp.block.noAuthority');
    case 'done':
      return t('ind.imp.block.done');
    case 'working':
      return t('ind.imp.block.working');
    case 'stale':
      return t('ind.imp.block.stale');
  }
}

export function problemMessage(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'ruleViolated':
      return t('ind.problem.ruleViolated.text');
    case 'mappingNotApproved':
      return t('ind.problem.mappingNotApproved.text');
    case 'alreadyApplied':
      return t('ind.problem.alreadyApplied.text');
    case 'hasErrors':
      return t('ind.problem.hasErrors.text');
    case 'hashMismatch':
      return t('ind.problem.hashMismatch.text');
    case 'schemaInvalid':
      return t('ind.problem.schemaInvalid.text');
    case 'empty':
      return t('ind.problem.empty.text');
    case 'fileRefused':
      return t('ind.problem.fileRefused.text');
    case 'tooLarge':
      return t('ind.problem.tooLarge.text');
    case 'scanPending':
      return t('ind.problem.scanPending.text');
    case 'periodLocked':
      return t('ind.problem.periodLocked.text');
    case 'validation':
      return t('ind.problem.validation.text', { field: problem.detail });
    case 'notFound':
      return t('ind.problem.notFound.text');
    case 'scopeDenied':
      return t('ind.problem.scopeDenied.text');
    case 'denied':
      return t('ind.problem.denied.text');
    case 'general':
      return t('ind.problem.general.text');
  }
}

export function failureText(t: T, code: string | null): string {
  return code === null ? t('ind.imp.failure.unknown') : t('ind.imp.failure.code', { code });
}
