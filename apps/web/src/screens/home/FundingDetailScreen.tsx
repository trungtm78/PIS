import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { categoryLabel, originLabel } from '../cap/labels';
import { vndText } from '../cap/model';
import '../dis/dis.css';
import './home.css';
import { YearField } from './funding-components';
import { useFunding } from './funding-hooks';
import type { DetailRow } from './funding-model';

const OVERVIEW_PATH = '/home/home-07';

/**
 * HOME-08: the sources and the scope of the calculation (ST-HOME-005, HOME 3 F6): each appropriation published for the year with its source, its origin, the amount, the inclusion relation ("independent", or "subset
 * of NSTW" for CTMTQG, which is shown under the appropriation it is inside and counted in no total) and the cut-off of the figure, then the total of what is added and the words that say what was counted.
 */
export default function FundingDetailScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DetailContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const tenant = useSession().tenant;
  const { register, years, year, funding, setYear } = useFunding();
  const state = useScreenState({ isLoading: register.isLoading, error: register.error, data: register.data === undefined ? undefined : years });
  const columns: DataTableColumn<DetailRow>[] = [
    { key: 'source', header: t('home.funding.detail.column.source'), pinned: true, render: (row) => row.label },
    { key: 'category', header: t('home.funding.detail.column.category'), render: (row) => categoryLabel(t, row.category) },
    { key: 'origin', header: t('home.funding.detail.column.origin'), render: (row) => (row.origin === null ? '' : originLabel(t, row.origin)) },
    { key: 'amount', header: t('home.funding.detail.column.amount'), align: 'right', render: (row) => vndText(row.vnd, locale) },
    {
      key: 'relation',
      header: t('home.funding.detail.column.relation'),
      render: (row) => (row.subsetOf === null ? t('home.funding.detail.relation.independent') : <StatusPill tone="info">{t('home.funding.detail.relation.subset')}</StatusPill>),
    },
    { key: 'cutoff', header: t('home.funding.detail.column.cutoff'), render: (row) => row.cutOff ?? t('home.funding.detail.cutoff.none') },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.funding.detail.title')}</h1>
          <p>{t('home.funding.detail.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="ui-button ui-button--outline" to={year === undefined ? OVERVIEW_PATH : `${OVERVIEW_PATH}?year=${year}`}>
            {t('home.funding.detail.back')}
          </Link>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void register.refetch()}>
        {funding === undefined ? null : (
          <div className="home-stack">
            <ContextBar items={[{ label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') }, { label: t('home.funding.year.label'), value: String(funding.year) }]} unit={t('dis.wr.unit')} />
            <FilterPanel unitLabel={t('dis.wr.unit')}>
              <YearField years={years} year={year} onChange={setYear} />
            </FilterPanel>
            <SectionCard title={t('home.funding.detail.table', { year: funding.year })} unit={t('dis.wr.unit')}>
              <div data-testid="funding-table">
                <DataTable
                  caption={t('home.funding.detail.table', { year: funding.year })}
                  columns={columns}
                  rows={funding.rows}
                  rowKey={(row) => row.key}
                  totalsLabel={t('home.funding.detail.total')}
                  totals={{ amount: funding.totalVnd === null ? t('home.funding.card.none') : vndText(funding.totalVnd, locale) }}
                />
              </div>
            </SectionCard>
            <div data-testid="funding-scope">
              <SectionCard title={t('home.funding.scope.title')}>
                <ul className="home-lines">
                  <li>{t('home.funding.scope.published', { year: funding.year })}</li>
                  <li>{t('home.funding.scope.subset')}</li>
                  <li>{t('home.funding.scope.cutoff')}</li>
                </ul>
              </SectionCard>
            </div>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
