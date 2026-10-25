import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { useCloseYear, useReopenYear, useYears } from './year/hooks';
import { fieldProblemMessage, problemMessage, statusLabel } from './year/labels';
import {
  CLOSE_PERMISSION,
  EMPTY_FORM,
  MAX_REASON,
  MAX_WINDOW_HOURS,
  MIN_WINDOW_HOURS,
  READ_PERMISSION,
  REOPEN_PERMISSION,
  actionsFor,
  describeProblem,
  openYear,
  validateClose,
  validateReopen,
  yearChoices,
} from './year/model';
import type { CloseTarget, FormField, YearForm } from './year/model';
import './cap.css';

type Dialog = 'SOFT_CLOSE' | 'LOCK' | 'REOPEN';
type Notice = 'softClosed' | 'locked' | 'reopened';

/**
 * CAP-11: the closing of a fiscal year of the capital plan. A year-close officer soft-closes a year (the adjustment period: it takes no plan command and no commitment, only what carries
 * capital out of it) and locks it (the capital that was not carried over, committed or disbursed lapses); a locked year is shown with a red banner, takes no write, and another officer
 * reopens it for a window of at most a week with a reason, after which it is locked again. The server judges every step; the screen offers only what the state of the year allows.
 */
export default function YearCloseScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The choice of the year, the dialog and the notices belong to one membership: a switch starts the screen over.
  return <YearCloseContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function YearCloseContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const canClose = holds(CLOSE_PERMISSION) && !frozen;
  const canReopen = holds(REOPEN_PERMISSION) && !frozen;
  const years = useYears(holds(READ_PERMISSION));
  const close = useCloseYear();
  const reopen = useReopenYear();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [form, setForm] = useState<YearForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [context, setContext] = useState<'close' | 'reopen'>('close');

  const rows = years.data ?? [];
  const today = useMemo(() => new Date(), []);
  const choices = yearChoices(rows, today);
  const asked = Number(params.get('year'));
  const year = Number.isInteger(asked) && asked > 0 ? asked : today.getUTCFullYear() - 1;
  const current = rows.find((row) => row.year === year) ?? openYear(year);
  const actions = actionsFor(current.status).filter((action) => (action === 'REOPEN' ? canReopen : canClose));
  const problems = dialog === undefined ? {} : dialog === 'REOPEN' ? validateReopen(form) : validateClose(form);
  const shown = attempted ? problems : {};
  const failure = context === 'close' ? close : reopen;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const state = useScreenState({ isLoading: years.isLoading, error: years.error, data: years.isLoading ? undefined : rows, isEmpty: () => false });
  const dateTime = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const errorOf = (field: FormField): string | undefined => {
    const found = shown[field];
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };

  const choose = (value: string): void => {
    setParams({ year: value });
    setDialog(undefined);
    setNotice(undefined);
    close.reset();
    reopen.reset();
  };
  const open = (action: Dialog): void => {
    setDialog(action);
    setForm(EMPTY_FORM);
    setAttempted(false);
    setNotice(undefined);
    close.reset();
    reopen.reset();
  };

  const finish = (done: Notice): void => {
    setNotice(done);
    setDialog(undefined);
  };

  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (dialog === undefined || close.isPending || reopen.isPending) return;
    if (Object.keys(problems).length > 0) {
      setAttempted(true);
      return;
    }
    const reason = form.reason.trim();
    if (dialog === 'REOPEN') {
      setContext('reopen');
      close.reset();
      reopen.mutate({ year, version: current.version, reason, hours: Number(form.hours.trim()) }, { onSuccess: () => finish('reopened'), onError: () => setDialog(undefined) });
      return;
    }
    const target: CloseTarget = dialog === 'LOCK' ? 'LOCKED' : 'SOFT_CLOSED';
    setContext('close');
    reopen.reset();
    close.mutate(
      { year, version: current.version, target, reason },
      { onSuccess: () => finish(target === 'LOCKED' ? 'locked' : 'softClosed'), onError: () => setDialog(undefined) },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="cap-year">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.year.page.title')}</h1>
          <p>{t('cap.year.page.subtitle')}</p>
        </div>
      </div>

      <StateBoundary state={state} onRetry={() => void years.refetch()}>
        <div className="card">
          <div className="cap-filters">
            <div>
              <label htmlFor="cap-year-select">{t('cap.year.field.year')}</label>
              <select id="cap-year-select" value={String(year)} onChange={(event) => choose(event.target.value)}>
                {[...new Set([...choices, year])]
                  .sort((a, b) => b - a)
                  .map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <dl className="cap-year-facts" data-testid="year-state" data-status={current.status} data-version={current.version}>
            <div>
              <dt>{t('cap.year.fact.status')}</dt>
              <dd>
                <span className={current.status === 'OPEN' ? 'cap-badge' : 'cap-badge warning'} data-status={current.status}>
                  {statusLabel(t, current.status)}
                </span>
              </dd>
            </div>
            {current.softClosedAt === undefined ? null : (
              <div>
                <dt>{t('cap.year.fact.softClosed')}</dt>
                <dd>{dateTime(current.softClosedAt)}</dd>
              </div>
            )}
            {current.lockedAt === undefined ? null : (
              <div>
                <dt>{t('cap.year.fact.locked')}</dt>
                <dd>{dateTime(current.lockedAt)}</dd>
              </div>
            )}
            {current.closeReason === undefined ? null : (
              <div>
                <dt>{t('cap.year.fact.closeReason')}</dt>
                <dd>{current.closeReason}</dd>
              </div>
            )}
            {current.reopenedUntil === undefined ? null : (
              <div>
                <dt>{current.status === 'OPEN' ? t('cap.year.fact.reopenedUntil') : t('cap.year.fact.lastReopenedUntil')}</dt>
                <dd>{dateTime(current.reopenedUntil)}</dd>
              </div>
            )}
            {current.reopenReason === undefined ? null : (
              <div>
                <dt>{t('cap.year.fact.reopenReason')}</dt>
                <dd>{current.reopenReason}</dd>
              </div>
            )}
          </dl>
          {current.status === 'LOCKED' ? (
            <p className="callout warning cap-year-locked" role="status" data-testid="year-locked">
              {t('cap.year.locked.banner', { year })}
            </p>
          ) : current.status === 'SOFT_CLOSED' ? (
            <p className="callout" role="status" data-testid="year-soft">
              {t('cap.year.soft.banner', { year })}
            </p>
          ) : null}
          {actions.length === 0 ? null : (
            <div className="row gap">
              {actions.map((action) => (
                <button key={action} type="button" className={action === 'LOCK' ? 'primary' : undefined} onClick={() => open(action)}>
                  {action === 'SOFT_CLOSE' ? t('cap.year.softClose.action') : action === 'LOCK' ? t('cap.year.lock.action') : t('cap.year.reopen.action')}
                </button>
              ))}
            </div>
          )}
          {dialog === undefined ? null : (
            <form className="cap-form" onSubmit={confirm} noValidate aria-label={t('cap.year.dialog.aria')} data-testid="dialog">
              <h2>
                {dialog === 'SOFT_CLOSE'
                  ? t('cap.year.dialog.title.softClose', { year })
                  : dialog === 'LOCK'
                    ? t('cap.year.dialog.title.lock', { year })
                    : t('cap.year.dialog.title.reopen', { year })}
              </h2>
              <p className="sub">
                {dialog === 'SOFT_CLOSE' ? t('cap.year.dialog.effect.softClose') : dialog === 'LOCK' ? t('cap.year.dialog.effect.lock') : t('cap.year.dialog.effect.reopen')}
              </p>
              <Field id="cap-year-reason" label={t('cap.year.field.reason')} error={errorOf('reason')}>
                <textarea
                  id="cap-year-reason"
                  rows={2}
                  maxLength={MAX_REASON}
                  value={form.reason}
                  aria-invalid={errorOf('reason') !== undefined}
                  onChange={(event) => setForm((currentForm) => ({ ...currentForm, reason: event.target.value }))}
                />
              </Field>
              {dialog !== 'REOPEN' ? null : (
                <Field
                  id="cap-year-hours"
                  label={t('cap.year.field.hours')}
                  error={errorOf('hours')}
                  hint={t('cap.year.hours.hint', { min: MIN_WINDOW_HOURS, max: MAX_WINDOW_HOURS })}
                >
                  <input
                    id="cap-year-hours"
                    inputMode="numeric"
                    value={form.hours}
                    aria-invalid={errorOf('hours') !== undefined}
                    onChange={(event) => setForm((currentForm) => ({ ...currentForm, hours: event.target.value }))}
                  />
                </Field>
              )}
              <div className="row gap">
                <button type="submit" className="primary" disabled={close.isPending || reopen.isPending}>
                  {dialog === 'SOFT_CLOSE' ? t('cap.year.dialog.confirm.softClose') : dialog === 'LOCK' ? t('cap.year.dialog.confirm.lock') : t('cap.year.dialog.confirm.reopen')}
                </button>
                <button type="button" onClick={() => setDialog(undefined)}>
                  {t('cap.year.dialog.cancel.action')}
                </button>
              </div>
            </form>
          )}
        </div>

        {notice === undefined ? null : (
          <p className="callout" role="status">
            {notice === 'softClosed' ? t('cap.year.done.softClosed', { year }) : notice === 'locked' ? t('cap.year.done.locked', { year }) : t('cap.year.done.reopened', { year })}
          </p>
        )}
        {problem === undefined ? null : (
          <div className="callout warning" role="alert">
            <p>{problemMessage(t, problem)}</p>
          </div>
        )}

        <div className="card">
          <h2>{t('cap.year.list.title')}</h2>
          {rows.length === 0 ? (
            <p className="sub" role="status" data-years-empty>
              {t('cap.year.list.empty')}
            </p>
          ) : (
            <div className="tablewrap cap-scroll">
              <table className="cap-table" aria-label={t('cap.year.list.title')}>
                <thead>
                  <tr>
                    <th>{t('cap.year.col.year')}</th>
                    <th>{t('cap.year.col.status')}</th>
                    <th>{t('cap.year.col.since')}</th>
                    <th>{t('cap.year.col.reopened')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.year} data-year={row.year} data-status={row.status}>
                      <td>{row.year}</td>
                      <td>
                        <span className={row.status === 'OPEN' ? 'cap-badge' : 'cap-badge warning'}>{statusLabel(t, row.status)}</span>
                      </td>
                      <td>{row.lockedAt !== undefined ? dateTime(row.lockedAt) : row.softClosedAt !== undefined ? dateTime(row.softClosedAt) : '—'}</td>
                      <td>{row.reopenedUntil === undefined ? '—' : t('cap.year.reopened.text', { until: dateTime(row.reopenedUntil) })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('cap.year.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
