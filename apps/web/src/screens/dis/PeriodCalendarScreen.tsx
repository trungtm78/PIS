import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field, StatusPill } from './components';
import { useGeneratePeriods, useNow, usePeriods } from './hooks';
import { fieldProblemMessage, moveLabel, problemMessage, reopenScopeLabel, reopenStatusLabel, statusLabel } from './labels';
import { PERIOD_LOCK_PERMISSION, PERIOD_MANAGE_PERMISSION, PERIOD_STATUSES, countsOf, describeProblem, hasPassed, movesOf, periodsOf, validateYear, vietnamMoment, yearsOf } from './model';
import type { FieldProblem, GeneratedPeriodType, PeriodMove, PeriodStatus, PeriodView } from './model';
import { TransitionDialog } from './TransitionDialog';

const NEVER_EMPTY = (): boolean => false;
const NONE = '–';

/**
 * DIS-14: the calendar of the reporting periods. Each period shows its status (Open, Soft closed, Locked: the one source of truth), its
 * deadline by the calendar version it was generated from, when it was locked, and the history of requests to reopen it. A period manager
 * generates the periods of a year and soft closes a period after its deadline; whoever holds the lock permission locks it; a maker only reads
 * (ST-DIS-001, DIS 3 F4).
 */
export default function PeriodCalendarScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters and the open dialog belong to one tenant: a switch starts the screen over.
  return <PeriodCalendarContent key={tenantId ?? 'none'} route={route} />;
}

function PeriodCalendarContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const now = useNow();
  const periods = usePeriods();
  const state = useScreenState({ isLoading: periods.isLoading, error: periods.error, data: periods.data, isEmpty: NEVER_EMPTY });
  const [chosenYear, setChosenYear] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<PeriodStatus | ''>('');
  const [moving, setMoving] = useState<{ id: string; move: PeriodMove } | undefined>(undefined);
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';
  const rights = { manage: holds(PERIOD_MANAGE_PERMISSION), lock: holds(PERIOD_LOCK_PERMISSION) };
  const all = periods.data ?? [];
  const currentYear = new Date(now).getFullYear();
  const years = yearsOf(all, currentYear);
  const year = chosenYear ?? currentYear;
  const rows = periodsOf(all, year, status);
  const counts = countsOf(all, year);
  const target = moving === undefined ? undefined : all.find((period) => period.id === moving.id);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.calendar.page.title')}</h1>
          <p>{t('dis.calendar.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') },
          { label: t('w2dis.calendar.ctx.year'), value: String(year) },
          { label: t('w2dis.calendar.ctx.periods'), value: periods.data === undefined ? NONE : String(counts.OPEN + counts.SOFT_CLOSED + counts.LOCKED) },
        ]}
      />
      <StateBoundary state={state} onRetry={() => void periods.refetch()}>
        {rights.manage ? <GeneratePeriods year={year} onGenerated={setChosenYear} /> : null}
        <FilterPanel
          applied={status === '' ? 0 : 1}
          actions={
            status === '' ? undefined : (
              <button type="button" className="ui-button ui-button--outline" onClick={() => setStatus('')}>
                {t('dis.reports.filter.clear.action')}
              </button>
            )
          }
        >
          <div className="dis-filters" role="group" aria-label={t('dis.calendar.filter.title')}>
            <Field id="calendar-year" label={t('dis.calendar.filter.year.label')} error={undefined}>
              <select id="calendar-year" value={year} onChange={(event) => setChosenYear(Number(event.target.value))}>
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="calendar-status" label={t('dis.calendar.filter.status.label')} error={undefined}>
              <select id="calendar-status" value={status} onChange={(event) => setStatus(event.target.value as PeriodStatus | '')}>
                <option value="">{t('dis.calendar.filter.all.option')}</option>
                {PERIOD_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {statusLabel(t, item)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </FilterPanel>
        <SectionCard title={t('dis.calendar.table.aria')}>
          {rows.length === 0 ? (
            <p className="dis-w2-empty" data-testid="empty-periods">
              {status === '' ? t('dis.calendar.empty.text', { year }) : t('dis.calendar.noMatch.text')}
            </p>
          ) : (
            <DataTable caption={t('dis.calendar.table.aria')} columns={periodColumns(t, now, rights, setMoving)} rows={rows} rowKey={(period) => period.id} />
          )}
          <p className="dis-w2-note" data-testid="count">
            {t('dis.calendar.count.text', { total: counts.OPEN + counts.SOFT_CLOSED + counts.LOCKED, open: counts.OPEN, softClosed: counts.SOFT_CLOSED, locked: counts.LOCKED })}
          </p>
        </SectionCard>
      </StateBoundary>
      {moving !== undefined && target !== undefined ? <TransitionDialog key={`${moving.id}-${moving.move}`} period={target} move={moving.move} onClose={() => setMoving(undefined)} /> : null}
      <p className="prototype-note">{t('dis.calendar.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** The columns of the calendar; a period is one row whose cells carry its code, status and history, and the moves that the caller may make on it. */
function periodColumns(t: Translate, now: number, rights: { manage: boolean; lock: boolean }, onMove: (target: { id: string; move: PeriodMove }) => void): DataTableColumn<PeriodView>[] {
  return [
    {
      key: 'period',
      header: t('dis.calendar.period.column'),
      pinned: true,
      render: (period) => (
        <span data-period-id={period.id} data-period-code={period.code} data-status={period.status}>
          <strong>{period.code}</strong>
          <span className="dis-code">{t('dis.calendar.version.text', { revision: period.calendarRevision })}</span>
        </span>
      ),
    },
    { key: 'start', header: t('dis.calendar.startsOn.column'), render: (period) => period.startDate },
    { key: 'end', header: t('dis.calendar.endsOn.column'), render: (period) => period.endDate },
    { key: 'deadline', header: t('dis.calendar.deadline.column'), render: (period) => <time dateTime={period.deadlineAt}>{vietnamMoment(period.deadlineAt)}</time> },
    { key: 'lock', header: t('dis.calendar.lock.column'), render: (period) => (period.lockedAt === null ? NONE : <time dateTime={period.lockedAt}>{vietnamMoment(period.lockedAt)}</time>) },
    {
      key: 'status',
      header: t('dis.calendar.status.column'),
      render: (period) => (
        <>
          <StatusPill status={period.status} />
          {period.softClosedAt === null ? null : <span className="dis-code">{t('dis.calendar.softClosedAt.text', { when: vietnamMoment(period.softClosedAt) })}</span>}
        </>
      ),
    },
    {
      key: 'history',
      header: t('dis.calendar.history.column'),
      render: (period) =>
        period.reopens.length === 0 ? (
          <span className="muted">{t('dis.calendar.history.none.text')}</span>
        ) : (
          <ul className="dis-history">
            {period.reopens.map((reopen) => (
              <li key={reopen.id} data-reopen-status={reopen.status}>
                {t('dis.calendar.history.item.text', { scope: reopenScopeLabel(t, reopen.scopeKind), status: reopenStatusLabel(t, reopen.status) })}
                {reopen.windowUntil === null ? null : ` ${t('dis.calendar.history.window.text', { when: vietnamMoment(reopen.windowUntil) })}`}
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'actions',
      header: t('dis.calendar.actions.column'),
      render: (period) => {
        // The caller may soft close periods: a period that is not due yet says so instead of offering a button that would be refused.
        const notDue = rights.manage && period.status === 'OPEN' && !hasPassed(period, now);
        return (
          <span className="dis-w2-actions">
            {movesOf(period, rights, now).map((move) => (
              <button key={move} type="button" className="ui-button ui-button--outline ui-button--small" data-move={move} onClick={() => onMove({ id: period.id, move })}>
                {moveLabel(t, move)}
              </button>
            ))}
            {notDue ? <span className="dis-w2-note">{t('dis.calendar.beforeDeadline.hint')}</span> : null}
          </span>
        );
      },
    },
  ];
}

function GeneratePeriods({ year, onGenerated }: { year: number; onGenerated(year: number): void }) {
  const { t } = useTranslation();
  const generate = useGeneratePeriods();
  const [text, setText] = useState(String(year));
  const [periodType, setPeriodType] = useState<GeneratedPeriodType>('WEEK');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const [done, setDone] = useState<number | undefined>(undefined);
  const refused = generate.isError ? describeProblem(generate.error) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (generate.isPending) return;
    const found = validateYear(text);
    setProblem(found);
    setDone(undefined);
    if (found !== undefined) return;
    const requested = Number(text.trim());
    generate.mutate(
      { year: requested, periodType },
      {
        onSuccess: () => {
          setDone(requested);
          onGenerated(requested);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-label={t('dis.calendar.generate.title')}>
      <SectionCard title={t('dis.calendar.generate.title')}>
        {refused === undefined ? null : (
          <p className="dis-w2-banner" role="alert">
            {problemMessage(t, refused)}
          </p>
        )}
        {done === undefined ? null : (
          <p className="dis-w2-banner dis-w2-banner--info" role="status" data-testid="generated">
            {t('dis.calendar.generate.done.notice', { year: done })}
          </p>
        )}
        <div className="dis-generate">
          <Field id="generate-year" label={t('dis.calendar.generate.year.label')} error={problem === undefined ? undefined : fieldProblemMessage(t, problem)} hint={t('dis.calendar.generate.hint.text')}>
            <input
              id="generate-year"
              inputMode="numeric"
              value={text}
              aria-invalid={problem !== undefined}
              onChange={(event) => {
                setText(event.target.value);
                setProblem(undefined);
              }}
            />
          </Field>
          <Field id="generate-type" label={t('dis.calendar.generate.type.label')} error={undefined}>
            <select id="generate-type" value={periodType} onChange={(event) => setPeriodType(event.target.value as GeneratedPeriodType)}>
              <option value="WEEK">{t('dis.calendar.generate.type.week')}</option>
              <option value="MONTH">{t('dis.calendar.generate.type.month')}</option>
            </select>
          </Field>
          <button type="submit" className="ui-button ui-button--primary" disabled={generate.isPending}>
            {t('dis.calendar.generate.submit.action')}
          </button>
        </div>
      </SectionCard>
    </form>
  );
}
