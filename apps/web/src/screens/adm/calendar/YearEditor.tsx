import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { MonthGrid, weekdayNames } from './MonthGrid';
import { SpecialDays } from './SpecialDays';
import { useCreateCalendarDraft, usePublishCalendar } from './hooks';
import { dayKindLabel, fieldMessage, findingMessage, problemMessage, statusLabel, statusTone } from './labels';
import { ISO_WEEKDAYS, REASON_MAX_LENGTH, REASON_MIN_LENGTH, calendarBody, emptyValues, rulesOf, rulesOfCalendar, validateCalendar, valuesOfCalendar, countWorkingDays, describeProblem } from './model';
import type { CalendarErrors, CalendarField, CalendarValues, CalendarView, DayKind } from './model';
import { applyPreset, restDaysOf, toggleRestDay, workingDaysByMonth } from './year-model';
import type { PresetResult, YearRow } from './year-model';

const MONTHS = Array.from({ length: 12 }, (_, month) => month);
const DAY_KINDS: readonly DayKind[] = ['working', 'off', 'holiday', 'compensated'];

export interface YearEditorProps {
  row: YearRow;
  /** The version the form starts from: the draft of the year, else the version in force, else a blank calendar. */
  source: CalendarView | undefined;
  canManage: boolean;
  /** The reason the form cannot be changed, already translated; undefined when it can. */
  lockedNotice: string | undefined;
  onOpenVersion: (id: string) => void;
  onSaved: (code: string) => void;
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

/**
 * ADM-07, one year: its state, the weekly rest days, the days added by range and the table of special days, the preset of the statutory holidays, the twelve months with the working days of each, and the two moves: save the calendar
 * (a new draft revision) and confirm the year (the draft becomes the version every deadline created afterwards is counted by; a deadline already counted does not move).
 */
export function YearEditor({ row, source, canManage, lockedNotice, onOpenVersion, onSaved }: YearEditorProps) {
  const { t, locale } = useTranslation();
  const create = useCreateCalendarDraft();
  const publish = usePublishCalendar();
  const [values, setValues] = useState<CalendarValues>(() => (source === undefined ? { ...emptyValues(row.year), calendarCode: row.code } : valuesOfCalendar(source)));
  // The text of the calendar the server holds (or accepted last): the same text is not saved again, which would be another revision, until it is edited.
  const [reference, setReference] = useState<string | undefined>(() => (source === undefined ? undefined : JSON.stringify(calendarBody(valuesOfCalendar(source)))));
  const [errors, setErrors] = useState<CalendarErrors>({});
  const [preset, setPreset] = useState<PresetResult | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const names = weekdayNames(locale, 'long');
  const editable = canManage && lockedNotice === undefined;
  const current = JSON.stringify(calendarBody(values));
  const unchanged = reference === current;
  const dirty = !unchanged && (reference !== undefined || values.holidays.length > 0 || values.compensated.length > 0 || values.legalBasis.trim() !== '');
  const draft = row.draft;
  const draftMatches = draft !== undefined && JSON.stringify(calendarBody(valuesOfCalendar(draft))) === current;
  const { workingDays, holidays, compensated } = values;
  const rules = useMemo(() => rulesOf({ workingDays, holidays, compensated }), [workingDays, holidays, compensated]);
  const perMonth = useMemo(() => workingDaysByMonth(rules, row.year), [rules, row.year]);
  const createProblem = create.isError ? describeProblem(create.error) : undefined;
  const publishProblem = publish.isError ? describeProblem(publish.error) : undefined;
  const fieldError = (field: CalendarField): string | undefined => (errors[field] === undefined ? undefined : fieldMessage(t, errors[field]));

  const change = (next: CalendarValues): void => {
    setValues(next);
    setErrors({});
  };

  const save = (): void => {
    if (create.isPending || !editable || unchanged) return;
    const found = validateCalendar(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = calendarBody(values);
    create.mutate(body, {
      onSuccess: () => {
        setReference(JSON.stringify(body));
        onSaved(body.calendar_code);
      },
    });
  };

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (publish.isPending || !editable || draft === undefined || !draftMatches) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    publish.mutate({ id: draft.id, version: draft.version, reason: trimmed }, { onSuccess: () => setConfirming(false) });
  };

  return (
    <SectionCard
      title={t('wfxcal.year.title', { year: row.year })}
      status={
        <span className="cal-chips">
          {row.confirmed === undefined ? null : <StatusPill tone="success" icon="✔">{t('wfxcal.state.confirmedRev.label', { revision: row.confirmed.revision })}</StatusPill>}
          {draft === undefined ? null : <StatusPill tone="warning" icon="✎">{t('wfxcal.state.draftRev.label', { revision: draft.revision })}</StatusPill>}
          {row.confirmed === undefined && draft === undefined ? <StatusPill tone="neutral">{t('wfxcal.state.none.label')}</StatusPill> : null}
          {dirty ? <StatusPill tone="info" icon="●">{t('wfxcal.state.unsaved.label')}</StatusPill> : null}
        </span>
      }
    >
      <div data-testid="year-editor" data-year={row.year} data-code={row.code}>
        {lockedNotice === undefined ? null : (
          <p className="callout warning" role="status">
            {lockedNotice}
          </p>
        )}
        {row.confirmed !== undefined ? null : (
          <p className="callout warning" role="note" data-testid="provisional-note">
            {t('wfxcal.provisional.note')}
          </p>
        )}
        {create.isSuccess && unchanged ? (
          <p className="callout" role="status">
            {t('wfxcal.save.accepted.notice')}
          </p>
        ) : null}
        {publish.isSuccess && row.confirmed !== undefined ? (
          <p className="callout" role="status" data-testid="confirmed-notice">
            {t('wfxcal.confirm.accepted.notice')}
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
        {publishProblem === undefined ? null : (
          <p className="callout warning" role="alert">
            {problemMessage(t, publishProblem)}
          </p>
        )}

        <div className="adm-kit-actions cal-toolbar">
            {editable ? (
              <>
                <button type="button" className="ui-button ui-button--primary" disabled={create.isPending || unchanged} onClick={save}>
                  {t('wfxcal.save.action')}
                </button>
                <button
                  type="button"
                  className="ui-button ui-button--outline"
                  disabled={!draftMatches || publish.isPending}
                  aria-expanded={confirming}
                  title={draftMatches ? undefined : t('wfxcal.confirm.needsSave.hint')}
                  onClick={() => {
                    setConfirming(!confirming);
                    setReason('');
                    setReasonError(false);
                  }}
                >
                  {t('wfxcal.confirm.action')}
                </button>
                <button
                  type="button"
                  className="ui-button ui-button--outline"
                  onClick={() => {
                    const result = applyPreset(values);
                    setPreset(result);
                    change(result.values);
                  }}
                >
                  {t('wfxcal.preset.action')}
                </button>
              </>
            ) : null}
        </div>
        {preset === undefined ? null : (
            <div className="callout" role="status" data-testid="preset-note">
              <StatusPill tone="warning" icon="⚠">
                {t('wfxcal.preset.unverified.label')}
              </StatusPill>{' '}
              {t('wfxcal.preset.done.status', { count: preset.added, year: row.year })}
              {preset.missing.length === 0 ? null : <> {t('wfxcal.preset.missing.status', { names: preset.missing.join(', ') })}</>}
            </div>
          )}
          {!confirming || !editable || draft === undefined ? null : (
            <div className="cal-confirm" role="group" aria-label={t('wfxcal.confirm.action')} data-testid="confirm-panel">
              <dl data-testid="confirm-preview">
                <dt>{t('wfxcal.confirm.preview.year')}</dt>
                <dd>{`${draft.calendarCode} ${draft.year} #${draft.revision}`}</dd>
                <dt>{t('wfxcal.confirm.preview.off')}</dt>
                <dd>{draft.holidays.length}</dd>
                <dt>{t('wfxcal.confirm.preview.work')}</dt>
                <dd>{draft.compensatedWorkdays.length}</dd>
                <dt>{t('wfxcal.confirm.preview.days')}</dt>
                <dd>{countWorkingDays(rulesOfCalendar(draft), draft.year)}</dd>
              </dl>
              <p className="sub">{t('wfxcal.confirm.impact.note', { year: draft.year })}</p>
              <div className="field">
                <label htmlFor="cal-confirm-reason">{t('wfxcal.confirm.reason.label')}</label>
                <input id="cal-confirm-reason" value={reason} aria-invalid={reasonError} onChange={(event) => { setReason(event.target.value); setReasonError(false); }} />
                {reasonError ? (
                  <small role="alert" className="field-error">
                    {t('adm.calendar.field.required')}
                  </small>
                ) : null}
              </div>
              <div className="adm-kit-actions">
                <button type="button" className="ui-button ui-button--primary" disabled={publish.isPending} onClick={(event) => confirm(event as unknown as FormEvent)}>
                  {t('wfxcal.confirm.submit.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline" onClick={() => setConfirming(false)}>
                  {t('wfxcal.confirm.cancel.action')}
                </button>
              </div>
            </div>
          )}

        <div role="group" aria-label={t('wfxcal.year.form.label', { year: row.year })}>
          <div className="cal-grid2">
            <div>
              {row.versions.length === 0 ? (
                <div className="field" data-field="calendar-code">
                  <label htmlFor="cal-code">{t('adm.calendar.code.label')}</label>
                  <input id="cal-code" value={values.calendarCode} disabled={!editable} aria-invalid={fieldError('calendarCode') !== undefined} onChange={(event) => change({ ...values, calendarCode: event.target.value })} />
                  <small className="sub">{t('wfxcal.code.hint')}</small>
                  {fieldError('calendarCode') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {fieldError('calendarCode')}
                    </small>
                  )}
                </div>
              ) : (
                <p className="sub" data-testid="calendar-code">
                  {t('wfxcal.code.read', { code: row.code })}
                </p>
              )}
              <fieldset className="cal-rest" disabled={!editable}>
                <legend>{t('wfxcal.rest.legend')}</legend>
                {ISO_WEEKDAYS.map((weekday) => (
                  <label key={weekday} className="check">
                    <input type="checkbox" checked={restDaysOf(values.workingDays).includes(weekday)} onChange={() => change(toggleRestDay(values, weekday))} />
                    {names[weekday - 1]}
                  </label>
                ))}
                {fieldError('workingDays') === undefined ? null : (
                  <small role="alert" className="field-error">
                    {fieldError('workingDays')}
                  </small>
                )}
              </fieldset>
              <div className="field" data-field="calendar-basis">
                <label htmlFor="cal-basis">{t('adm.calendar.basis.label')}</label>
                <input id="cal-basis" value={values.legalBasis} disabled={!editable} aria-invalid={fieldError('legalBasis') !== undefined} onChange={(event) => change({ ...values, legalBasis: event.target.value })} />
                <small className="sub">{t('adm.calendar.basis.hint')}</small>
                {fieldError('legalBasis') === undefined ? null : (
                  <small role="alert" className="field-error">
                    {fieldError('legalBasis')}
                  </small>
                )}
              </div>
            </div>
            <div className="cal-right">
              <SpecialDays values={values} year={row.year} editable={editable} problem={fieldError('holidays') ?? fieldError('compensated')} onChange={change} />
            </div>
          </div>
        </div>

        <div data-testid="month-grids">
          <h3>{t('wfxcal.months.title')}</h3>
          <Legend />
          <p className="sub" data-testid="year-count">
            {t('adm.calendar.summary.workingDays', { count: perMonth.reduce((sum, one) => sum + one, 0) })}
          </p>
          <div className="cal-months">
            {MONTHS.map((month) => (
              <MonthGrid key={month} rules={rules} year={row.year} month={month} workingDays={perMonth[month] ?? 0} />
            ))}
          </div>
        </div>

        {row.versions.length === 0 ? null : (
          <details className="cal-versions" data-testid="year-versions">
            <summary>{t('wfxcal.versions.title', { count: row.versions.length })}</summary>
            <KitTable caption={t('wfxcal.versions.caption')}>
              <thead>
                <tr>
                  <th>{t('adm.calendar.col.revision')}</th>
                  <th>{t('adm.calendar.col.status')}</th>
                  <th>{t('adm.calendar.col.basis')}</th>
                  <th>
                    <span className="ui-sr-only">{t('adm.calendar.col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.versions.map((version) => (
                  <tr key={version.id} data-calendar-id={version.id} data-status={version.status}>
                    <td>#{version.revision}</td>
                    <td>
                      <StatusPill tone={statusTone(version.status)}>{statusLabel(t, version.status)}</StatusPill>
                    </td>
                    <td>{version.legalBasis}</td>
                    <td>
                      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('wfxcal.versions.open.label', { revision: version.revision })} onClick={() => onOpenVersion(version.id)}>
                        {t('wfxcal.versions.open.action')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          </details>
        )}
      </div>
    </SectionCard>
  );
}
