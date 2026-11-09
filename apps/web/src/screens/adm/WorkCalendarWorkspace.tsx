import { useCallback, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { MonthGrid, weekdayNames } from './calendar/MonthGrid';
import { useCreateCalendarDraft, usePublishCalendar } from './calendar/hooks';
import { dayKindLabel, fieldMessage, findingMessage, problemMessage, statusLabel, statusTone } from './calendar/labels';
import {
  ISO_WEEKDAYS,
  MANAGE_CALENDAR_PERMISSION,
  MAX_YEAR,
  MIN_YEAR,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  calendarBody,
  countWorkingDays,
  describeProblem,
  emptyValues,
  rulesOf,
  rulesOfCalendar,
  setHolidayField,
  toggleDay,
  validateCalendar,
  valuesOfCalendar,
  withYear,
} from './calendar/model';
import type { CalendarErrors, CalendarField, CalendarValues, CalendarView, DayKind } from './calendar/model';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from './KitTable';
import './adm-kit.css';
import './calendar/calendar.css';

const MONTHS = Array.from({ length: 12 }, (_, month) => month);
const DAY_KINDS: readonly DayKind[] = ['working', 'off', 'holiday', 'compensated'];

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

function currentYear(): number {
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, new Date().getFullYear()));
}

/** The order of the register: the newest year first, a calendar's revisions newest first. */
function inRegisterOrder(versions: readonly CalendarView[]): CalendarView[] {
  return [...versions].sort((a, b) => b.year - a.year || a.calendarCode.localeCompare(b.calendarCode) || b.revision - a.revision);
}

/** What a person must see before publishing a draft: the year it covers and what it marks. */
function PublishPreview({ version }: { version: CalendarView }) {
  const { t } = useTranslation();
  return (
    <dl data-testid="publish-preview" aria-label={t('adm.calendar.preview.title')}>
      <dt>{t('adm.calendar.col.year')}</dt>
      <dd>{`${version.calendarCode} ${version.year} #${version.revision}`}</dd>
      <dt>{t('adm.calendar.holidays.title')}</dt>
      <dd>{version.holidays.length}</dd>
      <dt>{t('adm.calendar.compensated.title')}</dt>
      <dd>{version.compensatedWorkdays.length}</dd>
      <dt>{t('adm.calendar.summary.label')}</dt>
      <dd>{countWorkingDays(rulesOfCalendar(version), version.year)}</dd>
    </dl>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <ul className="cal-legend" aria-label={t('adm.calendar.legend.title')}>
      {DAY_KINDS.map((kind) => (
        <li key={kind}>
          <span className={`cal-day ${kind}`} aria-hidden="true" />
          {dayKindLabel(t, kind)}
        </li>
      ))}
    </ul>
  );
}

export interface WorkCalendarWorkspaceProps {
  route: WebRoute;
  /** The versions of the tenant, as the version reads return them. */
  versions: readonly CalendarView[];
}

/**
 * ADM-07: the working calendars of the tenant, one version per calendar year (ST-ADM-010). A version is written as a draft on
 * month grids (a click marks a holiday or a compensated working day) and published later; a published version is the one every
 * deadline created afterwards is counted by, and a deadline already counted does not move.
 */
export function WorkCalendarWorkspace({ route, versions }: WorkCalendarWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the form, the open publication, the reason) belongs to one tenant: a switch starts it over.
  return <WorkspaceContent key={tenantId ?? 'none'} route={route} versions={versions} />;
}

function WorkspaceContent({ route, versions }: WorkCalendarWorkspaceProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_CALENDAR_PERMISSION)) && !frozen;
  const create = useCreateCalendarDraft();
  const publish = usePublishCalendar();
  const register = useMemo(() => inRegisterOrder(versions), [versions]);
  const [values, setValues] = useState<CalendarValues>(() => emptyValues(currentYear()));
  const [errors, setErrors] = useState<CalendarErrors>({});
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  const [publishing, setPublishing] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  // The text of the draft the server accepted last: the same text is not saved again (it would be another revision) until it is edited.
  const [accepted, setAccepted] = useState<string | undefined>(undefined);
  const inView = register.find((version) => version.id === viewing) ?? register.find((version) => version.status === 'Published') ?? register[0];
  const createProblem = create.isError ? describeProblem(create.error) : undefined;
  const publishProblem = publish.isError ? describeProblem(publish.error) : undefined;
  const unchanged = accepted !== undefined && accepted === JSON.stringify(calendarBody(values));
  const year = Number(values.year);
  const yearValid = Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
  const { workingDays, holidays, compensated } = values;
  const rules = useMemo(() => rulesOf({ workingDays, holidays, compensated }), [workingDays, holidays, compensated]);
  const viewRules = useMemo(() => (inView === undefined ? undefined : rulesOfCalendar(inView)), [inView]);
  const names = weekdayNames(locale, 'long');

  const change = (update: (current: CalendarValues) => CalendarValues): void => {
    setValues(update);
    setErrors({});
  };
  const mark = useCallback((date: string): void => {
    setValues((current) => toggleDay(current, date));
    setErrors({});
  }, []);
  const setField = (field: 'calendarCode' | 'legalBasis', value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const toggleWeekday = (weekday: number): void =>
    change((current) => ({ ...current, workingDays: current.workingDays.includes(weekday) ? current.workingDays.filter((entry) => entry !== weekday) : [...current.workingDays, weekday] }));
  const fieldError = (field: CalendarField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldMessage(t, own);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canManage || unchanged) return;
    const found = validateCalendar(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = calendarBody(values);
    create.mutate(body, { onSuccess: () => setAccepted(JSON.stringify(body)) });
  };

  const confirmPublish = (event: FormEvent, version: CalendarView): void => {
    event.preventDefault();
    if (publish.isPending || !canManage) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    publish.mutate({ id: version.id, version: version.version, reason: trimmed }, { onSuccess: () => setPublishing(undefined) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.calendar.page.title')}</h1>
          <p>{t('adm.calendar.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" role="note" data-testid="placeholder-note">
        {t('adm.calendar.placeholder.note')}
      </p>
      <div className="adm-calendar">
        <SectionCard title={t('adm.calendar.versions.title')}>
          <div data-testid="versions">
          {register.length === 0 ? <p className="muted">{t('adm.calendar.versions.empty')}</p> : null}
          {publish.isSuccess ? (
            <p className="callout" role="status">
              {t('adm.calendar.publish.accepted.notice')}
            </p>
          ) : null}
          {publishProblem === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, publishProblem)}
            </p>
          )}
          {register.length === 0 ? null : (
            <KitTable caption={t('w2adm.calendar.table.versions')}>
              <thead>
                <tr>
                  <th>{t('adm.calendar.col.calendar')}</th>
                  <th>{t('adm.calendar.col.year')}</th>
                  <th>{t('adm.calendar.col.revision')}</th>
                  <th>{t('adm.calendar.col.status')}</th>
                  <th>{t('adm.calendar.col.basis')}</th>
                  <th>
                    {t('adm.calendar.col.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {register.map((version) => (
                  <tr key={version.id} data-calendar-id={version.id} data-status={version.status} aria-current={inView?.id === version.id ? 'true' : undefined}>
                    <td>{version.calendarCode}</td>
                    <td>{version.year}</td>
                    <td>#{version.revision}</td>
                    <td>
                      <StatusPill tone={statusTone(version.status)}>{statusLabel(t, version.status)}</StatusPill>
                    </td>
                    <td>{version.legalBasis}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setViewing(version.id)}>
                          {t('adm.calendar.view.action')}
                        </button>
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() => {
                              setValues(valuesOfCalendar(version));
                              setErrors({});
                              setAccepted(undefined);
                            }}
                          >
                            {t('adm.calendar.copy.action')}
                          </button>
                        ) : null}
                        {version.status === 'Draft' && canManage && publishing !== version.id ? (
                          <button
                            type="button"
                            onClick={() => {
                              setPublishing(version.id);
                              setReason('');
                              setReasonError(false);
                            }}
                          >
                            {t('adm.calendar.publish.action')}
                          </button>
                        ) : null}
                      </div>
                      {publishing === version.id && canManage ? (
                        <form onSubmit={(event) => confirmPublish(event, version)} noValidate aria-label={t('adm.calendar.publish.action')}>
                          <PublishPreview version={version} />
                          <Field id={`publish-reason-${version.id}`} label={t('adm.calendar.publish.reason.label')} error={reasonError ? t('adm.calendar.field.required') : undefined}>
                            <input
                              id={`publish-reason-${version.id}`}
                              value={reason}
                              aria-invalid={reasonError}
                              onChange={(event) => {
                                setReason(event.target.value);
                                setReasonError(false);
                              }}
                            />
                          </Field>
                          <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
                            {t('adm.calendar.publish.confirm.action')}
                          </button>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPublishing(undefined)}>
                            {t('adm.calendar.publish.cancel.action')}
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          {inView === undefined || viewRules === undefined ? null : (
            <div data-testid="version-in-view" data-calendar-id={inView.id}>
              <h3>{t('adm.calendar.inView.title', { calendar: inView.calendarCode, year: inView.year, revision: inView.revision })}</h3>
              <Legend />
              <p className="sub">{t('adm.calendar.summary.workingDays', { count: countWorkingDays(viewRules, inView.year) })}</p>
              <div className="cal-months">
                {MONTHS.map((month) => (
                  <MonthGrid key={month} rules={viewRules} year={inView.year} month={month} />
                ))}
              </div>
            </div>
          )}
          </div>
        </SectionCard>
        <SectionCard title={t('adm.calendar.form.title')}>
          <div data-testid="editor">
          {!canManage ? (
            <p className="callout warning" role="status">
              {frozen ? t('adm.calendar.frozen.notice') : t('adm.calendar.readOnly.notice')}
            </p>
          ) : null}
          {create.isSuccess && unchanged ? (
            <p className="callout" role="status">
              {t('adm.calendar.draft.accepted.notice')}
            </p>
          ) : null}
          {createProblem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, createProblem)}</p>
              {createProblem.findings.length === 0 ? null : (
                <ul>
                  {createProblem.findings.map((finding, index) => (
                    <li key={index}>{findingMessage(t, finding)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <form onSubmit={submit} noValidate aria-label={t('adm.calendar.form.title')}>
            <div className="formgrid">
              <Field id="calendar-code" label={t('adm.calendar.code.label')} error={fieldError('calendarCode')}>
                <input id="calendar-code" value={values.calendarCode} disabled={!canManage} aria-invalid={fieldError('calendarCode') !== undefined} onChange={(event) => setField('calendarCode', event.target.value)} />
              </Field>
              <Field id="calendar-year" label={t('adm.calendar.year.label')} error={fieldError('year')}>
                <input id="calendar-year" inputMode="numeric" value={values.year} disabled={!canManage} aria-invalid={fieldError('year') !== undefined} onChange={(event) => {
                    const { value } = event.target;
                    change((current) => withYear(current, value));
                  }} />
              </Field>
            </div>
            <fieldset className="scope-types" disabled={!canManage}>
              <legend>{t('adm.calendar.weekdays.legend')}</legend>
              {ISO_WEEKDAYS.map((weekday) => (
                <label key={weekday} className="check">
                  <input type="checkbox" checked={values.workingDays.includes(weekday)} onChange={() => toggleWeekday(weekday)} />
                  {names[weekday - 1]}
                </label>
              ))}
              {fieldError('workingDays') === undefined ? null : (
                <small role="alert" className="field-error">
                  {fieldError('workingDays')}
                </small>
              )}
            </fieldset>
            <Field id="calendar-basis" label={t('adm.calendar.basis.label')} error={fieldError('legalBasis')} hint={t('adm.calendar.basis.hint')}>
              <input id="calendar-basis" value={values.legalBasis} disabled={!canManage} aria-invalid={fieldError('legalBasis') !== undefined} onChange={(event) => setField('legalBasis', event.target.value)} />
            </Field>
            {yearValid ? (
              <div data-testid="editor-grids">
                <p className="sub">{t('adm.calendar.grid.hint')}</p>
                <Legend />
                <p className="sub">{t('adm.calendar.summary.workingDays', { count: countWorkingDays(rules, year) })}</p>
                <div className="cal-months">
                  {MONTHS.map((month) => (
                    <MonthGrid key={month} rules={rules} year={year} month={month} onToggle={canManage ? mark : undefined} />
                  ))}
                </div>
              </div>
            ) : null}
            <h3>{t('adm.calendar.holidays.title')}</h3>
            {values.holidays.length === 0 ? <p className="muted">{t('adm.calendar.holidays.empty')}</p> : null}
            {fieldError('holidays') === undefined ? null : (
              <small role="alert" className="field-error">
                {fieldError('holidays')}
              </small>
            )}
            {values.holidays.length === 0 ? null : (
              <KitTable caption={t('w2adm.calendar.table.holidays')} testId="holiday-list">
                <tbody>
                  {[...values.holidays]
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .map((holiday) => (
                      <tr key={holiday.date} data-holiday-date={holiday.date}>
                        <td>{holiday.date}</td>
                        <td>
                          <label className="sr-only" htmlFor={`holiday-name-${holiday.date}`}>
                            {t('adm.calendar.holiday.name.label')}
                          </label>
                          <input id={`holiday-name-${holiday.date}`} value={holiday.name} disabled={!canManage} onChange={(event) => {
                              const { value } = event.target;
                              change((current) => setHolidayField(current, holiday.date, 'name', value));
                            }} />
                        </td>
                        <td>
                          <label className="sr-only" htmlFor={`holiday-basis-${holiday.date}`}>
                            {t('adm.calendar.holiday.basis.label')}
                          </label>
                          <input id={`holiday-basis-${holiday.date}`} value={holiday.basis} disabled={!canManage} onChange={(event) => {
                              const { value } = event.target;
                              change((current) => setHolidayField(current, holiday.date, 'basis', value));
                            }} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </KitTable>
            )}
            <h3>{t('adm.calendar.compensated.title')}</h3>
            <p className="muted" data-testid="compensated-list">
              {values.compensated.length === 0 ? t('adm.calendar.compensated.empty') : [...values.compensated].sort().join(', ')}
            </p>
            <div className="adm-kit-actions">
              <span className="sub">{t('adm.calendar.form.hint')}</span>
              {canManage ? (
                <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending || unchanged}>
                  {t('adm.calendar.draft.submit.action')}
                </button>
              ) : null}
            </div>
          </form>
          </div>
        </SectionCard>
      </div>
      <p className="prototype-note">{t('adm.calendar.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
