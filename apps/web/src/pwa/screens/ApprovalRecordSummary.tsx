import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { RecordSummary, SummaryFact } from './approval-model';

type T = Translator['t'];

/** The facts the screen has words for, by the code the server gives; a code that is not here is not shown (a code is never a label). */
const FACT_KEYS = {
  SCORE_COMPUTED: 'scoreComputed',
  SCORE_ADJUSTED: 'scoreAdjusted',
  RATING: 'rating',
  SCORE_STATE: 'scoreState',
  RATED_TASKS: 'ratedTasks',
  TASK: 'task',
  DUE_DATE: 'dueDate',
  PROPOSED_FINISH: 'proposedFinish',
  CURRENT_FINISH: 'currentFinish',
  POINTS: 'points',
  EXCEPTION_KIND: 'exceptionKind',
} as const;
/** The facts the unified inbox added (lane fix12), worded in their own part. */
const FACT_KEYS_V12 = { ACTUAL_FINISH: 'actualFinish', VALID_FROM: 'validFrom', VALID_TO: 'validTo', WAIVED_ITEMS: 'waivedItems', FINISH_SHIFT_DAYS: 'finishShiftDays', CHANGED_TASKS: 'changedTasks' } as const;
const EXCEPTION_KEYS = { WAIVE_REQUIREMENT: 'waive', CANCEL_TASK: 'cancel', PAUSE: 'pause', EXTERNAL_DELAY: 'delay' } as const;
const STATUS_KEYS = { DRAFT: 'draft', LOCKED: 'locked', OFFICIAL: 'official' } as const;
const RATING_KEYS = { EXCELLENT: 'excellent', GOOD: 'good', FAIR: 'fair', WEAK: 'weak' } as const;
const STATE_KEYS = { RATED: 'rated', SMALL_SAMPLE: 'smallSample', NOT_RATED: 'notRated' } as const;

const known = <K extends string>(keys: Readonly<Record<K, string>>, code: string): code is K => Object.prototype.hasOwnProperty.call(keys, code);

/** A day of the server (`2026-07-01`, or an instant) as a person reads it: dd/mm/yyyy. */
export function summaryDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match === null ? value : `${match[3]}/${match[2]}/${match[1]}`;
}

/** The period of a record: its days and where it stands, in words. */
export function summaryPeriodText(t: T, period: NonNullable<RecordSummary['period']>): string {
  const days = t('fix11.apv.period.days', { from: summaryDay(period.from), to: summaryDay(period.to) });
  return known(STATUS_KEYS, period.status) ? t('fix11.apv.period.text', { days, status: t(`fix11.apvStatus.${STATUS_KEYS[period.status]}.word`) }) : days;
}

function factValue(t: T, fact: SummaryFact, locale: string): string {
  if (fact.value === null) return t('fix11.apv.fact.none');
  if (typeof fact.value === 'number') return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 2 }).format(fact.value);
  if (fact.code === 'RATING') return known(RATING_KEYS, fact.value) ? t(`fix11.apvRating.${RATING_KEYS[fact.value]}.word`) : fact.value;
  if (fact.code === 'EXCEPTION_KIND') return known(EXCEPTION_KEYS, fact.value) ? t(`fix12.apvException.${EXCEPTION_KEYS[fact.value]}.word`) : t('fix12.inbox.kind.exception');
  if (fact.code === 'SCORE_STATE') return known(STATE_KEYS, fact.value) ? t(`fix11.apvState.${STATE_KEYS[fact.value]}.word`) : t('fix11.apvState.notRated.word');
  return summaryDay(fact.value);
}

/** What the record of the task is, in full: nobody approves a response, an exception or an adjustment they cannot read (lane fix11). */
export function RecordSummaryFacts({ summary, sender }: { summary: RecordSummary; sender?: string | undefined }) {
  const { t, locale } = useTranslation();
  return (
    <div data-testid="record-summary">
      <dl className="pwa-facts">
        {summary.subjectName === null ? null : (
          <>
            <dt>{t('fix11.apv.subject.label')}</dt>
            <dd>{summary.subjectName}</dd>
          </>
        )}
        {sender === undefined ? null : (
          <>
            <dt>{t('fix11.apv.sender.label')}</dt>
            <dd>{sender}</dd>
          </>
        )}
        {summary.unitName === null ? null : (
          <>
            <dt>{t('fix11.apv.unit.label')}</dt>
            <dd>{summary.unitName}</dd>
          </>
        )}
        {summary.project === null ? null : (
          <>
            <dt>{t('fix11.apv.project.label')}</dt>
            <dd>{[summary.project.code, summary.project.name].filter((part) => part !== '').join(' · ')}</dd>
          </>
        )}
        {summary.period === null ? null : (
          <>
            <dt>{t('fix11.apv.period.label')}</dt>
            <dd data-testid="record-period">{summaryPeriodText(t, summary.period)}</dd>
          </>
        )}
        {summary.facts.map((fact) =>
          known(FACT_KEYS, fact.code) ? (
            <div key={fact.code} className="pwa-fact-pair" style={{ display: 'contents' }}>
              <dt>{t(`fix11.apvFact.${FACT_KEYS[fact.code]}.label`)}</dt>
              <dd data-fact={fact.code}>{factValue(t, fact, locale)}</dd>
            </div>
          ) : known(FACT_KEYS_V12, fact.code) ? (
            <div key={fact.code} className="pwa-fact-pair" style={{ display: 'contents' }}>
              <dt>{t(`fix12.apvFact.${FACT_KEYS_V12[fact.code]}.label`)}</dt>
              <dd data-fact={fact.code}>{factValue(t, fact, locale)}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <h3 className="pwa-subhead">{t('fix11.apv.body.title')}</h3>
      <p data-testid="record-body" style={{ whiteSpace: 'pre-wrap' }}>
        {summary.body ?? t('fix11.apv.body.none')}
      </p>
    </div>
  );
}
