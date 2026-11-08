import { ApiError } from '@machvon/api-client';
import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { InfoFormula, StatusPill } from '../../ui';
import type { InfoFormulaLabels, Tone } from '../../ui';
import { clockAndDay } from '../../ui/alerts/format';
import { defectText } from './labels';
import type { Person, RuleInfo } from './model';
import './alertgov.css';

type T = Translator['t'];

/** A moment as a person reads it ("09:30 15/10"); a dash for none. */
export const momentText = (moment: string | null): string => (moment === null || moment === '' ? '—' : clockAndDay(moment) || '—');

/** A day of the server (2026-11-09) as dd/mm/yyyy; the day as it came when it is not a day. */
export function dayText(day: string | null): string {
  if (day === null || !/^\d{4}-\d{2}-\d{2}/.test(day)) return day ?? '—';
  const [year, month, date] = day.slice(0, 10).split('-');
  return `${date}/${month}/${year}`;
}

export function personText(person: Person | null): string {
  return person === null ? '—' : (person.name ?? person.id.slice(0, 8));
}

export function infoLabels(t: T, name: string): InfoFormulaLabels {
  return {
    open: t('alertgov.info.open.label', { name }),
    close: t('alertgov.info.close.label'),
    formula: t('alertgov.info.formula.label'),
    numerator: t('alertgov.info.numerator.label'),
    denominator: t('alertgov.info.denominator.label'),
    exclusions: t('alertgov.info.exclusions.label'),
    source: t('alertgov.info.source.label'),
    asOf: t('alertgov.info.asOf.label'),
    owner: t('alertgov.info.owner.label'),
    version: t('alertgov.info.version.label'),
    unverified: t('alertgov.info.unverified.text'),
  };
}

export interface FigureInfoProps {
  name: string;
  formula: string;
  source: string;
  asOf: string;
  rule: RuleInfo;
}

/** The "i" of a figure: the formula, the source, the moment it is as of and the rule (with its version) whose numbers it is read against; a starting value nobody confirmed says so. */
export function FigureInfo({ name, formula, source, asOf, rule }: FigureInfoProps) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={name}
      formula={formula}
      source={source}
      asOf={momentText(asOf)}
      owner={t('alertgov.info.owner.text')}
      version={t('alertgov.info.version.text', { code: rule.code === '' ? 'DEFAULT' : rule.code, version: rule.version })}
      unverified={rule.unverified}
      labels={infoLabels(t, name)}
    />
  );
}

/** What is said under the numbers of a rule: its version, whether they are a starting value nobody confirmed, and where they come from. */
export function RuleNote({ rule }: { rule: RuleInfo }) {
  const { t } = useTranslation();
  return (
    <div className="alertgov-rule" data-testid="rule-note">
      <span>{t('alertgov.rule.version.text', { version: rule.version })}</span>
      {rule.unverified ? <StatusPill tone="warning">{t('alertgov.rule.unverified.label')}</StatusPill> : <StatusPill tone="success">{t('alertgov.rule.confirmed.label')}</StatusPill>}
      <span className="alertgov-rule__source">{rule.source}</span>
    </div>
  );
}

export function Banner({ tone, children, testId, role = 'status' }: { tone: 'warning' | 'danger' | 'info'; children: ReactNode; testId?: string; role?: 'status' | 'alert' }) {
  return (
    <div className={`alertgov-banner alertgov-banner--${tone}`} role={role} {...(testId === undefined ? {} : { 'data-testid': testId })}>
      {children}
    </div>
  );
}

export const TONE_OF: Readonly<Record<string, Tone>> = { OPEN: 'warning', ACKNOWLEDGED: 'info', CLOSED: 'neutral', PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', REVOKED: 'neutral', COVERED: 'success', PARTIAL: 'warning', UNCOVERED: 'danger', NOT_APPLICABLE: 'neutral' };

/**
 * What a command of these screens answered, in words: a stale version (409), a state that moved (409), a person who may not (403 and the self-approval), something that is not found (404, also for what is not theirs), a request that is not valid (422).
 * The code is the one the server gave; the words are ours.
 */
export function problemText(t: T, error: unknown): string {
  if (!(error instanceof ApiError)) return t('alertgov.problem.general.text');
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return t('alertgov.problem.conflict.text');
    case 'SELF_APPROVAL_DENIED':
      return t('alertgov.problem.self.text');
    case 'ALERT_ESCALATION_STATE_INVALID':
    case 'ALERT_ABSENCE_STATE_INVALID':
    case 'ALERT_COVER_STATE_INVALID':
      return t('alertgov.problem.state.text');
    case 'ALERT_ABSENCE_OVERLAP':
      return t('alertgov.problem.overlap.text');
    case 'ALERT_ABSENCE_INVALID':
    case 'ALERT_COVER_INVALID':
    case 'ALERT_PROFILE_INVALID':
    case 'VALIDATION_FAILED':
      return t('alertgov.problem.invalid.text');
    default:
      if (error.status === 403) return t('alertgov.problem.denied.text');
      if (error.status === 404) return t('alertgov.problem.notFound.text');
      return t('alertgov.problem.general.text');
  }
}

/** The defects of a refusal (422), one line each: the field and what is wrong with it. */
export function DefectList({ defects }: { defects: ReadonlyArray<{ field: string; code: string }> }) {
  const { t } = useTranslation();
  if (defects.length === 0) return null;
  return (
    <ul className="alertgov-defects" data-testid="defects">
      {defects.map((defect) => (
        <li key={`${defect.field}:${defect.code}`}>
          <code>{defect.field}</code>: {defectText(t, defect.code)}
        </li>
      ))}
    </ul>
  );
}
