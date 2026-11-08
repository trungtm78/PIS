import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { clockText } from '../home/overview-model';
import { vietnamDateTime } from '../rpt/model';
import { EmptyReason, Guarded, PartError, roleLabelOf } from './components';
import { useViewAudit } from './hooks';
import { PERMISSION, SCREENS, dayText, filtersText, isDay } from './model';
import type { AuditRow } from './model';

/**
 * BAN-07, the audit of views: who looked at which sensitive screen of the committee, in which place of the committee, with which filters, as of which day and from which feed, at which assurance level and when. It is read
 * only and append only; it holds counts and filters, never a figure; looking at it is itself written to the audit. It is read when the screen is opened or narrowed, and the next page when it is asked for.
 */
export default function ViewAuditScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.audit} title={t('ban.aud.page.title')} subtitle={t('ban.aud.page.subtitle')}>
      <AuditContent />
    </Guarded>
  );
}

function AuditContent() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const screen = SCREENS.find((one) => one === params.get('screen')) ?? '';
  const from = isDay(params.get('from') ?? '') ? (params.get('from') as string) : '';
  const to = isDay(params.get('to') ?? '') ? (params.get('to') as string) : '';
  const query = useViewAudit({ screen, from, to });
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const state = useScreenState({ isLoading: query.isLoading, error: query.data === undefined ? query.error : undefined, data: query.data, isEmpty: () => false });
  const narrow = (next: { screen?: string; from?: string; to?: string }): void => {
    const target = new URLSearchParams();
    const values = { screen: next.screen ?? screen, from: next.from ?? from, to: next.to ?? to };
    for (const [name, value] of Object.entries(values)) if (value !== '') target.set(name, value);
    setParams(target);
  };
  const screenLabel = (one: (typeof SCREENS)[number]): string =>
    one === 'WORKSPACE' ? t('ban.aud.screen.workspace') : one === 'ATTENTION' ? t('ban.aud.screen.attention') : one === 'MEETING_PACK' ? t('ban.aud.screen.meetingPack') : one === 'DIRECTIVE_TRACKER' ? t('ban.aud.screen.directiveTracker') : one === 'ALERTS' ? t('ban.aud.screen.alerts') : one === 'ROSTER' ? t('ban.aud.screen.roster') : t('ban.aud.screen.viewAudit');
  const screenName = (value: string): string => {
    const known = SCREENS.find((one) => one === value);
    return known === undefined ? value : screenLabel(known);
  };

  const columns: DataTableColumn<AuditRow>[] = [
    { key: 'when', header: t('ban.aud.col.when'), pinned: true, render: (row) => vietnamDateTime(row.viewed_at) },
    { key: 'who', header: t('ban.aud.col.who'), render: (row) => row.display_name ?? row.membership_id },
    { key: 'role', header: t('ban.aud.col.role'), render: (row) => (row.committee_role === null ? t('ban.aud.role.none') : roleLabelOf(t, row.committee_role)) },
    { key: 'screen', header: t('ban.aud.col.screen'), render: (row) => screenName(row.screen) },
    { key: 'filters', header: t('ban.aud.col.filters'), render: (row) => filtersText(row.filters) || t('ban.aud.filters.none') },
    { key: 'asOf', header: t('ban.aud.col.asOf'), render: (row) => (row.as_of === null ? '–' : dayText(row.as_of)) },
    { key: 'count', header: t('ban.aud.col.count'), align: 'right', render: (row) => (row.record_count === null ? '–' : row.record_count) },
    { key: 'feed', header: t('ban.aud.col.feed'), render: (row) => row.feed_basis ?? '–' },
    {
      key: 'assurance',
      header: t('ban.aud.col.assurance'),
      render: (row) => (
        <span data-assurance={row.assurance_level}>
          <StatusPill tone={row.assurance_level === 'MFA' ? 'success' : row.mfa_required ? 'warning' : 'neutral'} icon={row.assurance_level === 'MFA' ? '●' : '○'}>
            {row.assurance_level === 'MFA' ? t('ban.aud.assurance.mfa') : row.assurance_level === 'PASSWORD' ? t('ban.aud.assurance.password') : t('ban.aud.assurance.unknown')}
          </StatusPill>
          {row.mfa_required && row.assurance_level !== 'MFA' ? <div className="ban-muted">{t('ban.aud.assurance.required')}</div> : null}
        </span>
      ),
    },
  ];

  const filtered = screen !== '' || from !== '' || to !== '';
  return (
    <>
      <ContextBar items={[{ label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' }]} {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})} stale={query.isError && query.data !== undefined} />
      <div className="ban-audit-filters" role="group" aria-label={t('ban.aud.filter.aria')}>
        <label htmlFor="ban-aud-screen">
          <span>{t('ban.aud.filter.screen')}</span>
          <select id="ban-aud-screen" value={screen} onChange={(event) => narrow({ screen: event.target.value })}>
            <option value="">{t('ban.aud.filter.allScreens')}</option>
            {SCREENS.map((one) => (
              <option key={one} value={one}>
                {screenLabel(one)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="ban-aud-from">
          <span>{t('ban.aud.filter.from')}</span>
          <input id="ban-aud-from" type="date" value={from} onChange={(event) => narrow({ from: event.target.value })} />
        </label>
        <label htmlFor="ban-aud-to">
          <span>{t('ban.aud.filter.to')}</span>
          <input id="ban-aud-to" type="date" value={to} onChange={(event) => narrow({ to: event.target.value })} />
        </label>
      </div>
      <p className="callout" role="note">
        {t('ban.aud.note.text')}
      </p>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {query.data === undefined ? null : rows.length === 0 ? (
          <EmptyReason text={filtered ? t('ban.aud.empty.filtered.text') : t('ban.aud.empty.none.text')} testId="audit-empty" />
        ) : (
          <>
            <DataTable caption={t('ban.aud.table.caption')} columns={columns} rows={rows} rowKey={(row) => row.id} />
            <p className="ban-muted" data-testid="audit-count">
              {t('ban.aud.count.text', { count: rows.length })}
            </p>
            {query.isFetchNextPageError ? <PartError source={t('ban.aud.page.source')} onRetry={() => void query.fetchNextPage()} /> : null}
            {query.hasNextPage ? (
              <button type="button" className="ui-button ui-button--outline" disabled={query.isFetchingNextPage} data-testid="audit-older" onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? t('ban.aud.older.loading') : t('ban.aud.older.action')}
              </button>
            ) : (
              <p className="ban-muted" data-testid="audit-end">
                {t('ban.aud.end.text')}
              </p>
            )}
          </>
        )}
      </StateBoundary>
    </>
  );
}
