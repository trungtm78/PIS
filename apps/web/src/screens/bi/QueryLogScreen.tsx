import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useQueryRuns } from './hooks';
import { runModeLabel, runStatusLabel } from './query-log-labels';
import { EMPTY_RUN_FILTER, LOG_PERMISSION, RUN_STATUSES, summarise } from './query-log-model';
import type { RunFilter, RunStatus } from './query-log-model';
import './bi-kit.css';
import { StatusPill } from '../../ui';
import { runStatusTone } from './tones';

const NONE = '—';
const stamp = (value: string): string => value.slice(0, 19).replace('T', ' ');

/**
 * BI-13: the log of the queries (ST-BI-009, BI F3): who asked, when, which period, how long it took, how many rows, what it cost and whether the answer came from the cache, and how it ended; a heavy query that became a job is
 * a line with its own state. It never shows what a query asked or the figures it answered. It is the administrator's, over the whole tenant: a person who has less is refused by the server.
 */
export default function QueryLogScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <QueryLogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function QueryLogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const mayRead = permissions === undefined || permissions.includes(LOG_PERMISSION);
  const [form, setForm] = useState<RunFilter>(EMPTY_RUN_FILTER);
  const [applied, setApplied] = useState<RunFilter>(EMPTY_RUN_FILTER);
  const log = useQueryRuns(applied, mayRead);
  const runs = useMemo(() => (log.data?.pages ?? []).flatMap((page) => page.items), [log.data]);
  const state = useScreenState({ isLoading: log.isLoading, error: log.error, data: log.data === undefined ? undefined : runs });
  const summary = summarise(runs);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setApplied({ ...form });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.log.title')}</h1>
          <p>{t('bi.log.subtitle')}</p>
        </div>
      </div>
      <form className="card" onSubmit={submit} noValidate aria-label={t('bi.log.filter.title')}>
        <Field id="log-status" label={t('bi.log.status')} error={undefined}>
          <select id="log-status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as RunStatus | '' })}>
            <option value="">{t('bi.log.status.all')}</option>
            {RUN_STATUSES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {runStatusLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="log-period" label={t('bi.log.period')} error={undefined}>
          <input id="log-period" value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value })} />
        </Field>
        <div className="formfooter">
          <button type="submit" className="ui-button ui-button--primary" disabled={log.isFetching}>
            {t('bi.log.apply')}
          </button>
        </div>
      </form>
      <StateBoundary state={mayRead ? state : 'denied'} onRetry={() => void log.refetch()}>
        <p className="callout" data-testid="summary">
          {t('bi.log.summary', { runs: summary.runs, cached: summary.fromCache, jobs: summary.jobs, p95: summary.p95Ms === undefined ? NONE : t('bi.log.ms', { ms: summary.p95Ms }) })}
        </p>
        <table className="table" data-testid="runs" aria-label={t('bi.log.list.title')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.log.col.when')}</th>
              <th scope="col">{t('bi.log.col.period')}</th>
              <th scope="col">{t('bi.log.col.mode')}</th>
              <th scope="col">{t('bi.log.col.status')}</th>
              <th scope="col">{t('bi.log.col.duration')}</th>
              <th scope="col">{t('bi.log.col.rows')}</th>
              <th scope="col">{t('bi.log.col.cost')}</th>
              <th scope="col">{t('bi.log.col.cache')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} data-run={run.id} data-status={run.status} data-mode={run.mode}>
                <td>{stamp(run.createdAt)}</td>
                <td>{run.asOfPeriod}</td>
                <td>{runModeLabel(t, run.mode)}</td>
                <td>
                  <StatusPill tone={runStatusTone(run.status)}>{runStatusLabel(t, run.status)}</StatusPill>
                  {run.errorCode === null ? null : <p className="sub">{run.errorCode}</p>}
                </td>
                <td>{run.durationMs === null ? NONE : t('bi.log.ms', { ms: run.durationMs })}</td>
                <td>{run.rowCount ?? NONE}</td>
                <td>{run.estimatedCost ?? NONE}</td>
                <td>{run.servedFromCache ? t('bi.log.cache.yes') : t('bi.log.cache.no')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.hasNextPage ? (
          <button type="button" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('bi.log.more')}
          </button>
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('bi.log.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
