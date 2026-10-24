import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmationLabel, Field } from './components';
import { useGenerateObligations, useObligations } from './hooks';
import type { ObligationFilter } from './hooks';
import { generationMessage, reportStatusLabel, roleLabel } from './labels';
import { describeGenerationProblem, groupByMonth, isOverdue, validateYear, vietnamToday, yearsAround } from './model';
import { MANAGE_CALENDAR_PERMISSION, REPORT_STATUSES } from './types';
import type { GenerationResult, ObligationView, ReportStatus } from './types';
import './mne.css';

/** MNE-01: the calendar of the filing obligations of a year, by due date, with the form, the level, the recipient and the confirmation label. */
export default function ObligationCalendarScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters and the result of a generation belong to one tenant: a switch starts the screen over.
  return <ObligationCalendarContent key={tenantId ?? 'none'} route={route} />;
}

function ObligationCalendarContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const today = vietnamToday();
  const frozen = mode === 'READ_ONLY';
  const mayGenerate = (permissions === undefined || permissions.includes(MANAGE_CALENDAR_PERMISSION)) && !frozen;
  const [filter, setFilter] = useState<ObligationFilter>({ year: Number(today.slice(0, 4)), status: '' });
  const list = useObligations(filter);
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const months = useMemo(() => groupByMonth(items), [items]);
  const overdue = items.filter(isOverdue).length;
  // The state replaces the table, not the filters or the generation: a year without obligations is where the generation starts.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items });
  const years = yearsAround(today, [filter.year]);

  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.calendar.page.title')}</h1>
          <p>{t('mne.calendar.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout">{t('mne.calendar.rule.notice')}</p>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('mne.calendar.frozen.notice')}
        </p>
      ) : null}
      <div className="card">
        <div className="mne-filters" role="group" aria-label={t('mne.calendar.filter.title')}>
          <Field id="calendar-year" label={t('mne.calendar.filter.year.label')} error={undefined}>
            <select id="calendar-year" value={filter.year} onChange={(event) => setFilter({ ...filter, year: Number(event.target.value) })}>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </Field>
          <Field id="calendar-status" label={t('mne.calendar.filter.status.label')} error={undefined}>
            <select id="calendar-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as ReportStatus | '' })}>
              <option value="">{t('mne.calendar.filter.all.option')}</option>
              {REPORT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {reportStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {mayGenerate ? <GenerateYear year={filter.year} /> : null}
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {months.map((group) => (
            <div key={group.month} data-month={group.month}>
              <h2 className="mne-month">{t('mne.calendar.month.heading', { month: group.month.slice(5), year: group.month.slice(0, 4) })}</h2>
              <div className="tablewrap">
                <table aria-label={t('mne.calendar.table.aria', { month: group.month.slice(5), year: group.month.slice(0, 4) })}>
                  <thead>
                    <tr>
                      <th>{t('mne.calendar.col.form')}</th>
                      <th>{t('mne.calendar.col.level')}</th>
                      <th>{t('mne.calendar.col.unit')}</th>
                      <th>{t('mne.calendar.col.period')}</th>
                      <th>{t('mne.calendar.col.due')}</th>
                      <th>{t('mne.calendar.col.recipient')}</th>
                      <th>{t('mne.calendar.col.legal')}</th>
                      <th>{t('mne.calendar.col.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item) => (
                      <ObligationRow key={item.reportId} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <div className="row between gap tiny muted">
            <span data-testid="count">{t('mne.calendar.count.text', { total: items.length, late: overdue })}</span>
            {list.hasNextPage ? (
              <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('mne.calendar.more.action')}
              </button>
            ) : null}
          </div>
        </StateBoundary>
      </div>
      <p className="prototype-note">{t('mne.calendar.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ObligationRow({ item }: { item: ObligationView }) {
  const { t } = useTranslation();
  const overdue = isOverdue(item);
  return (
    <tr data-report-id={item.reportId} data-due-date={item.dueDate} className={overdue ? 'mne-late' : undefined}>
      <td>
        <strong>{item.formCode}</strong>
        <div className="sub">{item.formTitle}</div>
      </td>
      <td>{roleLabel(t, item.reportingRole)}</td>
      <td>
        <code>{item.unitCode}</code>
        <div className="sub">{item.unitName}</div>
      </td>
      <td>{item.periodLabel}</td>
      <td>
        <time dateTime={item.dueDate}>{item.dueDate}</time>
      </td>
      <td>{item.recipient}</td>
      <td className="mne-legal">
        <div>{item.legalBasis}</div>
        <div className="mne-badges">
          <ConfirmationLabel awaiting={item.awaitingConfirmation} cxnRefs={item.cxnRefs} />
        </div>
      </td>
      <td>
        <div className="mne-badges">
          <span className="pill gray">{reportStatusLabel(t, item.status)}</span>
          {overdue ? <span className="pill red">{t('mne.calendar.late.text', { days: item.daysLate ?? 0 })}</span> : null}
          {item.isLate && !overdue ? <span className="pill red">{t('mne.calendar.late.unknown')}</span> : null}
        </div>
      </td>
    </tr>
  );
}

/** Generates the obligations of the year on the screen; the year can be written over before it is generated. */
function GenerateYear({ year: shown }: { year: number }) {
  const { t } = useTranslation();
  const generate = useGenerateObligations();
  const [text, setText] = useState<string | undefined>(undefined);
  const [refusedYear, setRefusedYear] = useState(false);
  const [result, setResult] = useState<GenerationResult | undefined>(undefined);
  const written = text ?? String(shown);
  const failure = generate.isError ? describeGenerationProblem(generate.error) : undefined;

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (generate.isPending) return;
    const year = validateYear(written);
    setRefusedYear(year === undefined);
    if (year === undefined) return;
    generate.mutate(year, { onSuccess: (generated) => setResult(generated) });
  };

  return (
    <form onSubmit={send} noValidate aria-label={t('mne.calendar.generate.title')} className="stack">
      <h2>{t('mne.calendar.generate.title')}</h2>
      <p className="sub">{t('mne.calendar.generate.hint')}</p>
      <div className="row gap">
        <Field id="generate-year" label={t('mne.calendar.generate.year.label')} error={refusedYear ? t('mne.calendar.generate.year.error') : undefined}>
          <input
            id="generate-year"
            inputMode="numeric"
            value={written}
            aria-invalid={refusedYear}
            onChange={(event) => {
              setText(event.target.value);
              setRefusedYear(false);
              setResult(undefined);
            }}
          />
        </Field>
        <button type="submit" className="primary" disabled={generate.isPending}>
          {t('mne.calendar.generate.action')}
        </button>
      </div>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert">
          {generationMessage(t, failure)}
        </p>
      )}
      {result === undefined ? null : (
        <p className="callout" role="status" data-testid="generated">
          {t('mne.calendar.generate.done.notice', { created: result.created, existing: result.existing })}
        </p>
      )}
      {result === undefined || result.unresolvedRoles.length === 0 ? null : (
        <p className="callout warning" role="status" data-testid="unresolved">
          {t('mne.calendar.generate.unresolved.warning', { roles: result.unresolvedRoles.map((role) => roleLabel(t, role)).join(', ') })}
        </p>
      )}
    </form>
  );
}
