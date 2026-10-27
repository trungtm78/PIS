import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
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
  const { permissions, mode } = useSession();
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
      <StateBoundary state={state} onRetry={() => void periods.refetch()}>
        {rights.manage ? <GeneratePeriods year={year} onGenerated={setChosenYear} /> : null}
        <div className="card">
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
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-periods">
              {status === '' ? t('dis.calendar.empty.text', { year }) : t('dis.calendar.noMatch.text')}
            </p>
          ) : (
            <table className="table" aria-label={t('dis.calendar.table.aria')}>
              <thead>
                <tr>
                  <th>{t('dis.calendar.period.column')}</th>
                  <th>{t('dis.calendar.startsOn.column')}</th>
                  <th>{t('dis.calendar.endsOn.column')}</th>
                  <th>{t('dis.calendar.deadline.column')}</th>
                  <th>{t('dis.calendar.lock.column')}</th>
                  <th>{t('dis.calendar.status.column')}</th>
                  <th>{t('dis.calendar.history.column')}</th>
                  <th>
                    <span className="sr-only">{t('dis.calendar.actions.column')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((period) => (
                  <PeriodRow key={period.id} period={period} now={now} moves={movesOf(period, rights, now)} mayClose={rights.manage} onMove={(move) => setMoving({ id: period.id, move })} />
                ))}
              </tbody>
            </table>
          )}
          <p className="sub" data-testid="count">
            {t('dis.calendar.count.text', { total: counts.OPEN + counts.SOFT_CLOSED + counts.LOCKED, open: counts.OPEN, softClosed: counts.SOFT_CLOSED, locked: counts.LOCKED })}
          </p>
        </div>
      </StateBoundary>
      {moving !== undefined && target !== undefined ? <TransitionDialog key={`${moving.id}-${moving.move}`} period={target} move={moving.move} onClose={() => setMoving(undefined)} /> : null}
      <p className="prototype-note">{t('dis.calendar.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface PeriodRowProps {
  period: PeriodView;
  now: number;
  moves: PeriodMove[];
  /** The caller may soft close periods: a period that is not due yet says so instead of offering a button that would be refused. */
  mayClose: boolean;
  onMove(move: PeriodMove): void;
}

function PeriodRow({ period, now, moves, mayClose, onMove }: PeriodRowProps) {
  const { t } = useTranslation();
  const notDue = mayClose && period.status === 'OPEN' && !hasPassed(period, now);
  return (
    <tr data-period-id={period.id} data-period-code={period.code} data-status={period.status}>
      <td>
        {period.code}
        <span className="dis-code">{t('dis.calendar.version.text', { revision: period.calendarRevision })}</span>
      </td>
      <td>{period.startDate}</td>
      <td>{period.endDate}</td>
      <td>
        <time dateTime={period.deadlineAt}>{vietnamMoment(period.deadlineAt)}</time>
      </td>
      <td>{period.lockedAt === null ? NONE : <time dateTime={period.lockedAt}>{vietnamMoment(period.lockedAt)}</time>}</td>
      <td>
        <StatusPill status={period.status} />
        {period.softClosedAt === null ? null : <span className="dis-code">{t('dis.calendar.softClosedAt.text', { when: vietnamMoment(period.softClosedAt) })}</span>}
      </td>
      <td>
        {period.reopens.length === 0 ? (
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
        )}
      </td>
      <td className="row-actions">
        {moves.map((move) => (
          <button key={move} type="button" data-move={move} onClick={() => onMove(move)}>
            {moveLabel(t, move)}
          </button>
        ))}
        {notDue ? <span className="sub">{t('dis.calendar.beforeDeadline.hint')}</span> : null}
      </td>
    </tr>
  );
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
    <form className="card" onSubmit={submit} noValidate aria-label={t('dis.calendar.generate.title')}>
      <h2>{t('dis.calendar.generate.title')}</h2>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="generated">
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
        <button type="submit" className="primary" disabled={generate.isPending}>
          {t('dis.calendar.generate.submit.action')}
        </button>
      </div>
    </form>
  );
}
