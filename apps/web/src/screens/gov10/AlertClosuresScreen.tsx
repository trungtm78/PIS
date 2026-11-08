import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { sourceLabel } from '../../ui/alerts/AlertRow';
import { useClosureSummary, useClosures, useFlood, useStorms } from './hooks';
import type { Closure, Storm } from './model';
import { Provenance, when } from './parts';

/**
 * HOME-31: what became of the alerts. The ones the system closed because the condition of their source cleared (never when a source could not be read), the ones that came back, the ones that closed with no record of anyone having
 * acted, and the storms of new alerts with how the centre protected the list (the cards that gather the new alerts below the urgent level; an urgent alert is never gathered). The figures are counted from events, each with its
 * formula; the state of the reader's own list is on top.
 */
export default function AlertClosuresScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <ClosuresContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ClosuresContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [withoutRecord, setWithoutRecord] = useState(false);
  const [reopened, setReopened] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const summary = useClosureSummary();
  const closures = useClosures({ withoutRecord, reopened }, cursors[cursors.length - 1]);
  const storms = useStorms();
  const flood = useFlood();
  const state = useScreenState({ isLoading: summary.isLoading, error: summary.data === undefined ? summary.error : undefined, data: summary.data, isEmpty: () => false });
  const stale = summary.data !== undefined && (summary.isError || closures.isError);
  const figures = summary.data;

  const columns: DataTableColumn<Closure>[] = [
    { key: 'type', header: t('gov10.closures.column.type'), pinned: true, render: (row) => <><strong>{row.alertType ?? row.source}</strong> <span className="dis-code">{sourceLabel(t, row.source)}</span></> },
    { key: 'first', header: t('gov10.closures.column.first'), render: (row) => <time dateTime={row.firstSeenAt}>{when(row.firstSeenAt)}</time> },
    { key: 'closed', header: t('gov10.closures.column.closed'), render: (row) => (row.closedAt === null ? '—' : <time dateTime={row.closedAt}>{when(row.closedAt)}</time>) },
    { key: 'reopened', header: t('gov10.closures.column.reopened'), align: 'right', render: (row) => String(row.reopenCount) },
    {
      key: 'record',
      header: t('gov10.closures.column.record'),
      render: (row) => (row.closedWithoutRecord ? <StatusPill tone="warning">{t('gov10.closures.noRecord')}</StatusPill> : t('gov10.closures.decisions', { count: row.decisionsBeforeClose ?? 0 })),
    },
  ];
  const stormColumns: DataTableColumn<Storm>[] = [
    { key: 'started', header: t('gov10.storms.column.started'), pinned: true, render: (row) => <time dateTime={row.startedAt}>{when(row.startedAt)}</time> },
    { key: 'ended', header: t('gov10.storms.column.ended'), render: (row) => (row.endedAt === null ? <StatusPill tone="warning">{t('gov10.storms.ongoing')}</StatusPill> : <time dateTime={row.endedAt}>{when(row.endedAt)}</time>) },
    { key: 'peak', header: t('gov10.storms.column.peak'), align: 'right', render: (row) => t('gov10.storms.peakOf', { peak: row.peakNew, window: row.windowMinutes }) },
    { key: 'grouped', header: t('gov10.storms.column.grouped'), align: 'right', render: (row) => String(row.groupedCount) },
    { key: 'line', header: t('gov10.storms.column.line'), render: (row) => t('gov10.storms.lineOf', { start: row.startAbove, end: row.endBelow }) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov10.closures.title')}</h1>
          <p>{t('gov10.closures.subtitle')}</p>
        </div>
      </div>
      <div className="gov10-stack">
        <SectionCard
          title={t('gov10.flood.title')}
          status={
            flood.data === undefined ? undefined : (
              <Provenance
                name={t('gov10.flood.title')}
                formula={flood.data.policy.formula}
                source={flood.data.policy.source}
                asOf={flood.data.policy.ruleAsOf}
                version={flood.data.policy.version === 'builtin' ? t('gov10.info.versionDefault') : t('gov10.info.versionRule', { version: flood.data.policy.version })}
                unverified={flood.data.policy.unverified}
                owner={t('gov10.flood.owner')}
              />
            )
          }
        >
          {flood.isLoading ? (
            <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
          ) : flood.data === undefined ? (
            <p role="alert" data-testid="flood-error">
              {t('gov10.flood.failed')}{' '}
              <button type="button" className="mv-alert-link" onClick={() => void flood.refetch()}>
                {t('gov10.state.retry.label')}
              </button>
            </p>
          ) : (
            <>
              <p data-testid="flood-state" data-active={flood.data.stormActive ? 'true' : 'false'}>
                {flood.data.stormActive ? t('gov10.flood.active', { since: when(flood.data.since), count: flood.data.newInWindow, window: flood.data.policy.windowMinutes }) : t('gov10.flood.calm', { count: flood.data.newInWindow, window: flood.data.policy.windowMinutes })}
              </p>
              <p>{t('gov10.flood.today', { count: flood.data.newToday, cap: flood.data.policy.maxNewPerDay })}</p>
              {flood.data.unavailable.length > 0 ? (
                <p className="gov10-notice gov10-notice--warn" role="status" data-testid="flood-unavailable">
                  {t('gov10.flood.unavailable', { sources: flood.data.unavailable.map((source) => sourceLabel(t, source)).join(', ') })}
                </p>
              ) : null}
              {flood.data.groups.length === 0 ? (
                <p data-testid="flood-no-groups">{t('gov10.flood.noGroups')}</p>
              ) : (
                <ul data-testid="flood-groups">
                  {flood.data.groups.map((group) => (
                    <li key={group.key}>{t('gov10.flood.group', { count: group.count, source: group.source === null ? group.dimension : sourceLabel(t, group.source) })}</li>
                  ))}
                </ul>
              )}
              <p>{t('gov10.flood.urgentApart')}</p>
            </>
          )}
        </SectionCard>
        <StateBoundary state={state} onRetry={() => void summary.refetch()}>
          {figures?.denied === true ? (
            <p className="gov10-notice" role="alert" data-testid="closures-denied">
              {t('gov10.closures.denied')}
            </p>
          ) : (
            <>
              <ContextBar items={[{ label: t('gov10.closures.ctx.period'), value: figures === undefined ? '—' : `${figures.from} / ${figures.to}` }, { label: t('gov10.closures.ctx.open'), value: String(figures?.openNow ?? 0) }]} {...(figures === undefined || figures.asOf === '' ? {} : { asOf: figures.asOf })} stale={stale} />
              <KpiStrip>
                <KpiTile label={t('gov10.closures.kpi.closed')} value={String(figures?.closedBySystem ?? 0)} />
                <KpiTile label={t('gov10.closures.kpi.reopened')} value={String(figures?.reopened ?? 0)} tone={(figures?.reopened ?? 0) > 0 ? 'warning' : 'default'} />
                <KpiTile label={t('gov10.closures.kpi.noRecord')} value={String(figures?.closedWithoutRecord ?? 0)} tone={(figures?.closedWithoutRecord ?? 0) > 0 ? 'warning' : 'default'} />
                <KpiTile label={t('gov10.closures.kpi.median')} value={figures?.medianHoursOpen === null || figures === undefined ? t('gov10.closures.kpi.none') : t('gov10.closures.kpi.hours', { hours: figures.medianHoursOpen })} />
              </KpiStrip>
              <p className="gov10-notice">
                {t('gov10.closures.formula')}{' '}
                <Provenance name={t('gov10.closures.title')} formula={figures?.formula ?? null} source={t('gov10.closures.source')} asOf={figures?.asOf ?? null} version={t('gov10.info.versionDefault')} unverified={false} owner={t('gov10.closures.owner')} />
              </p>
              <div className="gov10-filters">
                <label>
                  <input
                    type="checkbox"
                    checked={withoutRecord}
                    onChange={(event) => {
                      setWithoutRecord(event.target.checked);
                      setCursors([]);
                    }}
                  />{' '}
                  {t('gov10.closures.filter.noRecord')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={reopened}
                    onChange={(event) => {
                      setReopened(event.target.checked);
                      setCursors([]);
                    }}
                  />{' '}
                  {t('gov10.closures.filter.reopened')}
                </label>
                <Link to="/home/home-30" className="mv-alert-link">
                  {t('gov10.closures.feedbackLink')}
                </Link>
              </div>
              {closures.isLoading ? (
                <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
              ) : closures.data === undefined ? (
                <p role="alert" data-testid="closures-error">
                  {t('gov10.closures.failed')}{' '}
                  <button type="button" className="mv-alert-link" onClick={() => void closures.refetch()}>
                    {t('gov10.state.retry.label')}
                  </button>
                </p>
              ) : closures.data.items.length === 0 ? (
                <p className="gov10-notice" role="status" data-testid="closures-empty">
                  {withoutRecord || reopened ? t('gov10.closures.empty.filtered') : t('gov10.closures.empty.none')}
                </p>
              ) : (
                <>
                  <DataTable caption={t('gov10.closures.title')} columns={columns} rows={closures.data.items} rowKey={(row) => row.id} />
                  <nav className="gov10-pager" aria-label={t('gov10.pager.label')}>
                    <button type="button" className="mv-alert-button" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
                      {t('gov10.pager.previous')}
                    </button>
                    <button type="button" className="mv-alert-button" disabled={closures.data.nextCursor === null} onClick={() => closures.data.nextCursor === null || setCursors([...cursors, closures.data.nextCursor])}>
                      {t('gov10.pager.next')}
                    </button>
                  </nav>
                </>
              )}
              <SectionCard title={t('gov10.storms.title')}>
                {storms.isLoading ? (
                  <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
                ) : storms.data === undefined ? (
                  <p role="alert" data-testid="storms-error">
                    {t('gov10.storms.failed')}{' '}
                    <button type="button" className="mv-alert-link" onClick={() => void storms.refetch()}>
                      {t('gov10.state.retry.label')}
                    </button>
                  </p>
                ) : storms.data.length === 0 ? (
                  <p className="gov10-notice" role="status" data-testid="storms-empty">
                    {t('gov10.storms.empty')}
                  </p>
                ) : (
                  <DataTable caption={t('gov10.storms.title')} columns={stormColumns} rows={storms.data} rowKey={(row) => row.id} />
                )}
              </SectionCard>
            </>
          )}
        </StateBoundary>
      </div>
    </section>
  );
}
