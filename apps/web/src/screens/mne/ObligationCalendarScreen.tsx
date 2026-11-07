import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ConfirmationLabel, Field } from './components';
import { useGenerateObligations, useObligations } from './hooks';
import type { ObligationFilter } from './hooks';
import { generationMessage, reportStatusLabel, roleLabel } from './labels';
import { describeGenerationProblem, groupByMonth, isOverdue, validateYear, vietnamToday, yearsAround } from './model';
import { reportStatusTone } from './tones';
import { MANAGE_CALENDAR_PERMISSION, REPORT_STATUSES } from './types';
import type { GenerationResult, ObligationView, ReportStatus } from './types';
import './mne.css';
import './mne-kit.css';

type Translate = ReturnType<typeof useTranslation>['t'];

/** MNE-01: the calendar of the filing obligations of a year, by due date, with the form, the level, the recipient and the confirmation label. */
export default function ObligationCalendarScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters and the result of a generation belong to one tenant: a switch starts the screen over.
  return <ObligationCalendarContent key={tenantId ?? 'none'} route={route} />;
}

function ObligationCalendarContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
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
  const columns = useMemo(() => obligationColumns(t), [t]);

  return (
    <section className="mne" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.calendar.page.title')}</h1>
          <p>{t('mne.calendar.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('mne.calendar.ctx.scope'), value: tenant?.name ?? t('mne.calendar.ctx.scope.all') },
          { label: t('mne.calendar.ctx.year'), value: String(filter.year) },
        ]}
        {...(list.dataUpdatedAt > 0 ? { asOf: new Date(list.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <p className="callout">{t('mne.calendar.rule.notice')}</p>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('mne.calendar.frozen.notice')}
        </p>
      ) : null}
      <FilterPanel applied={filter.status === '' ? 0 : 1}>
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
      </FilterPanel>
      {mayGenerate ? <GenerateYear year={filter.year} /> : null}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {months.map((group) => (
          <div key={group.month} data-month={group.month} className="mne-month-card">
            <SectionCard title={t('mne.calendar.month.heading', { month: group.month.slice(5), year: group.month.slice(0, 4) })}>
              <DataTable
                caption={t('mne.calendar.table.aria', { month: group.month.slice(5), year: group.month.slice(0, 4) })}
                columns={columns}
                rows={group.items}
                rowKey={(item) => item.reportId}
                rowAttrs={(item) => ({ 'data-report-id': item.reportId, 'data-due-date': item.dueDate })}
                severity={(item) => (isOverdue(item) ? 'URGENT' : null)}
              />
            </SectionCard>
          </div>
        ))}
        <div className="row between gap tiny muted mne-count">
          <span data-testid="count">{t('mne.calendar.count.text', { total: items.length, late: overdue })}</span>
          {list.hasNextPage ? (
            <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('mne.calendar.more.action')}
            </button>
          ) : null}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('mne.calendar.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The columns of a month: the form (code and title) stays pinned, the state is a pill and the lateness is written with its days. */
function obligationColumns(t: Translate): DataTableColumn<ObligationView>[] {
  return [
    {
      key: 'form',
      header: t('mne.calendar.col.form'),
      pinned: true,
      render: (item) => (
        <>
          <strong>{item.formCode}</strong>
          <div className="sub">{item.formTitle}</div>
        </>
      ),
    },
    { key: 'level', header: t('mne.calendar.col.level'), render: (item) => roleLabel(t, item.reportingRole) },
    {
      key: 'unit',
      header: t('mne.calendar.col.unit'),
      render: (item) => (
        <>
          <code>{item.unitCode}</code>
          <div className="sub">{item.unitName}</div>
        </>
      ),
    },
    { key: 'period', header: t('mne.calendar.col.period'), render: (item) => item.periodLabel },
    { key: 'due', header: t('mne.calendar.col.due'), render: (item) => <time dateTime={item.dueDate}>{item.dueDate}</time> },
    { key: 'recipient', header: t('mne.calendar.col.recipient'), render: (item) => item.recipient },
    {
      key: 'legal',
      header: t('mne.calendar.col.legal'),
      render: (item) => (
        <div className="mne-legal">
          <div>{item.legalBasis}</div>
          <div className="mne-badges">
            <ConfirmationLabel awaiting={item.awaitingConfirmation} cxnRefs={item.cxnRefs} />
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('mne.calendar.col.status'),
      render: (item) => {
        const late = isOverdue(item);
        return (
          <div className="mne-badges">
            <StatusPill tone={reportStatusTone(item.status)}>{reportStatusLabel(t, item.status)}</StatusPill>
            {late ? <StatusPill tone="danger">{t('mne.calendar.late.text', { days: item.daysLate ?? 0 })}</StatusPill> : null}
            {item.isLate && !late ? <StatusPill tone="danger">{t('mne.calendar.late.unknown')}</StatusPill> : null}
          </div>
        );
      },
    },
  ];
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
    <div className="mne-generate">
      <SectionCard title={t('mne.calendar.generate.title')}>
        <form onSubmit={send} noValidate aria-label={t('mne.calendar.generate.title')} className="stack">
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
            <button type="submit" className="ui-button ui-button--primary" disabled={generate.isPending}>
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
      </SectionCard>
    </div>
  );
}
