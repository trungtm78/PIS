import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { hasMessage, useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { PREVIEW_PERIODS, PeriodTable } from './CalendarPreview';
import { camel } from './catalogues';
import { useCatalogue } from './hooks';
import { PROPOSE_PERMISSION, recordLink } from './model';
import type { RecordView } from './model';
import { calendarOf, reportingPeriods } from './reporting-calendar';

const HISTORY_PATH = '/mdm/mdm-28';
const EDIT_PATH = '/mdm/mdm-26';
const CALENDAR_TYPE = 'CALENDAR';
/** The calendar that DIS generates its periods from: the rule port reads this key and no other. */
const CALENDAR_KEY = 'DEFAULT';
/** The longest wait a timer takes (about 24 days); a later deadline is waited for in turns. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** A moment after the deadline, so that the check finds it passed. */
const DEADLINE_MARGIN_MS = 50;
const NEVER_EMPTY = (): boolean => false;
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

/** The calendar in force the way the server reads it: the platform's entry before a tenant's own. */
function calendarRecord(records: readonly RecordView[]): RecordView | undefined {
  const inForce = records.filter((record) => record.businessKey === CALENDAR_KEY && record.status === 'EFFECTIVE' && calendarOf(record.attributes) !== undefined);
  return inForce.find((record) => record.namespace === 'PLATFORM') ?? inForce[0];
}

/**
 * MDM-11: the reporting calendar: how the weeks are counted and when a report is due, with the periods of a year generated from it. The
 * periods that DIS stores keep the version of the calendar they came from, so a new version changes the periods after it and none before.
 */
export default function CalendarScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <CalendarContent key={tenantId ?? 'none'} route={route} />;
}

function CalendarContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const [now, setNow] = useState(() => Date.now());
  const requested = Number(params.get('year'));
  const year = Number.isInteger(requested) && requested >= FIRST_YEAR && requested <= LAST_YEAR ? requested : new Date(now).getFullYear();
  // What is typed in the field stays as typed until it is a year; the periods follow only a year.
  const [yearText, setYearText] = useState(String(year));
  useEffect(() => setYearText(String(year)), [year]);
  const [all, setAll] = useState(false);
  const entries = useCatalogue([CALENDAR_TYPE]);
  const state = useScreenState({ isLoading: entries.isLoading, error: entries.error, data: entries.data, isEmpty: NEVER_EMPTY });
  const record = calendarRecord(entries.data ?? []);
  const calendar = record === undefined ? undefined : calendarOf(record.attributes);
  const canEdit = record !== undefined && record.namespace === 'TENANT' && record.openChangeRequestId === null && (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  const periods = useMemo(() => (calendar === undefined ? [] : reportingPeriods(calendar, year)), [calendar, year]);
  const shown = useMemo(() => (all ? periods : periods.slice(0, PREVIEW_PERIODS)), [all, periods]);
  // A period turns from open to locked at its deadline even while the screen stays open: the clock moves to the next deadline of the list.
  useEffect(() => {
    const next = shown.map((period) => Date.parse(period.deadlineAt)).filter((deadline) => deadline > now).sort((left, right) => left - right)[0];
    if (next === undefined) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - now + DEADLINE_MARGIN_MS, MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [shown, now]);
  const valueText = (family: string, raw: unknown): string => {
    const key = typeof raw === 'string' ? `mdm.value.${family}.${camel(raw)}` : '';
    return typeof raw === 'string' ? (hasMessage(key) ? t(key) : raw) : '';
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.calendar.page.title')}</h1>
          <p>{t('mdm.catalogue.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void entries.refetch()}>
        {record === undefined || calendar === undefined ? (
          <p className="callout warning" role="status" data-testid="no-calendar">
            {t('mdm.calendar.empty.text')}
          </p>
        ) : (
          <>
            <section className="card" aria-label={t('mdm.calendar.rule.title')} data-testid="calendar-rule">
              <h2>
                {t('mdm.calendar.rule.title')}{' '}
                {record.attributes.awaiting_confirmation === true ? (
                  <span className="pill warn">{t('mdm.rule.awaiting.pill', { cxn: String(record.attributes.cxn ?? '') })}</span>
                ) : (
                  <span className="pill green">{t('mdm.rule.confirmed.pill')}</span>
                )}
              </h2>
              <p data-testid="calendar-text">
                {t('mdm.calendar.rule.text', {
                  start: valueText('weekday', calendar.weekStartsOn),
                  deadline: valueText('weekday', calendar.deadlineWeekday),
                  time: calendar.deadlineTime,
                  zone: calendar.timezone,
                })}
              </p>
              <dl>
                <dt>{t('mdm.rule.legalBasis.label')}</dt>
                <dd>{record.legalBasis ?? ''}</dd>
                <dt>{t('mdm.rule.validity.label')}</dt>
                <dd>{record.validFrom === null ? '' : `${record.validFrom} → ${record.validUntil ?? t('mdm.rule.open.text')}`}</dd>
                <dt>{t('mdm.calendar.version.label')}</dt>
                <dd>{record.revision === null ? '' : t('mdm.calendar.version.text', { revision: record.revision })}</dd>
              </dl>
              <div className="formfooter">
                <Link to={recordLink(HISTORY_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.calendar.history.action')}</Link>
                {canEdit ? (
                  <Link className="button primary" to={recordLink(EDIT_PATH, record.masterType, record.businessKey, record.namespace)}>
                    {t('mdm.calendar.edit.action')}
                  </Link>
                ) : null}
              </div>
              {record.namespace === 'PLATFORM' ? (
                <p className="callout" role="status" data-testid="calendar-locked">
                  {t('mdm.calendar.locked.notice')}
                </p>
              ) : null}
            </section>
            <section className="card" aria-label={t('mdm.calendar.periods.title')}>
              <h2>{t('mdm.calendar.periods.title')}</h2>
              <div className="mdm-filters">
                <div className="field">
                  <label htmlFor="calendar-year">{t('mdm.calendar.year.label')}</label>
                  <input
                    id="calendar-year"
                    type="number"
                    min={FIRST_YEAR}
                    max={LAST_YEAR}
                    value={yearText}
                    onChange={(event) => {
                      setYearText(event.target.value);
                      const typed = Number(event.target.value);
                      if (event.target.value !== '' && Number.isInteger(typed) && typed >= FIRST_YEAR && typed <= LAST_YEAR) setParams({ year: String(typed) });
                    }}
                    onBlur={() => setYearText(String(year))}
                  />
                </div>
                <button type="button" aria-pressed={all} onClick={() => setAll((current) => !current)}>
                  {all ? t('mdm.calendar.first.action', { count: PREVIEW_PERIODS }) : t('mdm.calendar.all.action', { count: periods.length })}
                </button>
              </div>
              <PeriodTable periods={shown} now={now} />
              <p className="sub" data-testid="period-count">
                {t('mdm.calendar.count.text', { shown: shown.length, total: periods.length })}
              </p>
            </section>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.catalogue.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
