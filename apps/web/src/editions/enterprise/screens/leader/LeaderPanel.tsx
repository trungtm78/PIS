import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../../../i18n';
import type { LeaderPanelPart } from '../../../edition';
import { DirectiveWidget } from '../../../../screens/dir/DirectiveWidget';
import { DataTable, KpiStrip, KpiTile, SectionCard } from '../../../../ui';
import type { DataTableColumn } from '../../../../ui';
import { moneyText } from '../shared/format';
import { useBlockedProjects, useLeaderRates } from './hooks';
import type { BlockedProjects, LeaderRateRow } from './hooks';
import { deltaText, percentText } from './model';
import './leader.css';

/** How many project rows the panel lists; the rest is said as a count. */
const PROJECT_ROWS = 15;

const refused = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);

function Rates() {
  const { t, locale } = useTranslation();
  const trendText = (trend: LeaderRateRow['trend']): string => (trend === 'UP' ? t('ent.leader.trend.up') : trend === 'DOWN' ? t('ent.leader.trend.down') : trend === 'FLAT' ? t('ent.leader.trend.flat') : '');
  const nullText = (reason: string | null): string => (reason === 'ZERO_DENOMINATOR' ? t('ent.leader.null.zeroPlan') : t('ent.leader.null.noData'));
  const read = useLeaderRates();
  const data = read.data;
  if (read.isLoading) return <SectionCard title={t('ent.leader.rates.title')}><p role="status" aria-busy="true">{t('ent.leader.loading.text')}</p></SectionCard>;
  if (data === undefined) {
    // Nothing frozen yet is a state to say, not an error; any other failure keeps its retry.
    return (
      <SectionCard title={t('ent.leader.rates.title')}>
        {refused(read.error) ? (
          <p role="status" data-testid="leader-rates-empty">{t('ent.leader.rates.empty')}</p>
        ) : (
          <p role="alert" data-testid="leader-rates-error">
            {t('ent.leader.error.text')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void read.refetch()}>
              {t('ent.leader.retry.action')}
            </button>
          </p>
        )}
      </SectionCard>
    );
  }
  const money = (value: string | null | undefined): string => (value === null || value === undefined ? t('ent.leader.noData.text') : moneyText(value, locale));
  const rateCell = (row: LeaderRateRow): string => (row.rate_pct === null ? t('ent.leader.noData.text') : percentText(row.rate_pct, locale));
  const lastCell = (row: LeaderRateRow): string => (row.last_year.rate_pct !== null ? percentText(row.last_year.rate_pct, locale) : row.last_year.null_reason === 'NO_PRIOR_SNAPSHOT' ? t('ent.leader.lastYear.none') : row.last_year.null_reason === 'NOT_IN_PRIOR_SNAPSHOT' ? t('ent.leader.lastYear.new') : t('ent.leader.noData.text'));
  const columns = (first: string): DataTableColumn<LeaderRateRow>[] => [
    { key: 'name', header: first, pinned: true, render: (row) => `${row.code ?? ''} ${row.name ?? ''}`.trim() },
    { key: 'plan', header: t('ent.leader.col.plan'), align: 'right', render: (row) => (row.plan_vnd === '0' && row.rate_pct === null ? t('ent.leader.noData.text') : money(row.plan_vnd)) },
    { key: 'disbursed', header: t('ent.leader.col.disbursed'), align: 'right', render: (row) => money(row.disbursed_vnd) },
    { key: 'rate', header: t('ent.leader.col.rate'), align: 'right', render: rateCell },
    { key: 'last', header: t('ent.leader.col.lastYear'), align: 'right', render: lastCell },
    { key: 'delta', header: t('ent.leader.col.delta'), align: 'right', render: (row) => (row.delta_points === null ? t('ent.leader.noData.text') : `${deltaText(row.delta_points, locale)} ${trendText(row.trend)}`) },
  ];
  const company = data.company;
  return (
    <SectionCard title={t('ent.leader.rates.title')} unit={t('ent.leader.rates.unit')}>
      <div data-testid="leader-rates">
        <KpiStrip label={t('ent.leader.company.aria')}>
          <KpiTile label={t('ent.leader.company.rate')} value={rateCell(company)} sub={company.rate_pct === null ? nullText(company.null_reason ?? null) : `${money(company.disbursed_vnd)} / ${money(company.plan_vnd)}`} tone="info" />
          <KpiTile label={t('ent.leader.company.lastYear')} value={lastCell(company)} sub={data.prior_as_of_date === null || data.prior_as_of_date === undefined ? t('ent.leader.lastYear.none') : t('ent.leader.lastYear.asOf', { day: data.prior_as_of_date })} />
          <KpiTile label={t('ent.leader.company.delta')} value={company.delta_points === null ? t('ent.leader.noData.text') : deltaText(company.delta_points, locale)} sub={company.trend === null ? undefined : trendText(company.trend)} tone={company.trend === 'DOWN' ? 'warning' : company.trend === 'UP' ? 'success' : 'neutral'} />
        </KpiStrip>
        <p className="muted" data-testid="leader-rates-context">
          {t('ent.leader.context.text', { day: data.as_of_date, revision: data.revision ?? 0 })}
        </p>
        <DataTable caption={t('ent.leader.units.caption')} columns={columns(t('ent.leader.col.unit'))} rows={data.units} rowKey={(row) => row.id ?? row.code ?? ''} state={data.units.length === 0 ? 'empty' : 'ready'} />
        <DataTable caption={t('ent.leader.projects.caption')} columns={columns(t('ent.leader.col.project'))} rows={data.projects.slice(0, PROJECT_ROWS)} rowKey={(row) => row.id ?? row.code ?? ''} state={data.projects.length === 0 ? 'empty' : 'ready'} />
        {data.projects.length > PROJECT_ROWS ? <p className="muted">{t('ent.leader.projects.more', { count: data.projects.length - PROJECT_ROWS })}</p> : null}
      </div>
    </SectionCard>
  );
}

function Blocked({ data }: { data: BlockedProjects }) {
  const { t } = useTranslation();
  const sourceText = (source: string): string => (source === 'PERMIT' ? t('ent.leader.source.permit') : source === 'ISSUE' ? t('ent.leader.source.issue') : source === 'LAND' ? t('ent.leader.source.land') : t('ent.leader.source.procurement'));
  return (
    <div data-testid="leader-blocked">
      <KpiStrip label={t('ent.leader.blocked.aria')}>
        <KpiTile label={t('ent.leader.blocked.total')} value={String(data.total)} sub={t('ent.leader.blocked.formula')} tone={data.total > 0 ? 'warning' : 'success'} />
        {(['PERMIT', 'ISSUE', 'LAND', 'PROCUREMENT'] as const).map((source) => (
          <KpiTile key={source} label={sourceText(source)} value={String(data.by_source[source] ?? 0)} />
        ))}
      </KpiStrip>
      {data.projects.length === 0 ? (
        <p role="status">{t('ent.leader.blocked.none')}</p>
      ) : (
        <ul className="leader-blocked-list">
          {data.projects.slice(0, PROJECT_ROWS).map((project) => (
            <li key={project.project_id}>
              <strong>{project.project_code}</strong> {project.project_name} · {project.sources.map(sourceText).join(', ')} · {t('ent.leader.blocked.days', { days: project.days })}
            </li>
          ))}
        </ul>
      )}
      {data.truncated ? <p className="muted">{t('ent.leader.blocked.truncated')}</p> : null}
    </div>
  );
}

function Tiles() {
  const { t } = useTranslation();
  const read = useBlockedProjects();
  return (
    <>
      <SectionCard title={t('ent.leader.blocked.title')}>
        {read.isLoading ? (
          <p role="status" aria-busy="true">{t('ent.leader.loading.text')}</p>
        ) : read.data === undefined ? (
          <p role="alert" data-testid="leader-blocked-error">
            {refused(read.error) ? t('ent.leader.denied.text') : t('ent.leader.error.text')}{' '}
            {refused(read.error) ? null : (
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void read.refetch()}>
                {t('ent.leader.retry.action')}
              </button>
            )}
          </p>
        ) : (
          <Blocked data={read.data} />
        )}
      </SectionCard>
      <DirectiveWidget />
    </>
  );
}

/**
 * The leader panel of the enterprise edition (ENT-4d, HSKT BC.02 and CN.03), placed by the command center and the committee dashboard through the slot of the edition: the disbursement against the annual plan by
 * company, unit and project with the same period of last year; the projects blocked on procedure; the directives that are overdue (the widget of DIR). A figure that cannot be given is said, never shown as 0.
 */
export function LeaderPanel({ part }: { part: LeaderPanelPart }) {
  return (
    <div className="leader-panel" data-testid="leader-panel" data-part={part}>
      {part === 'tiles' ? null : <Rates />}
      {part === 'rates' ? null : <Tiles />}
    </div>
  );
}

export default LeaderPanel;
