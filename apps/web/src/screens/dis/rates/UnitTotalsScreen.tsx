import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import '../dis.css';
import { CoveragePill, DefinitionBadge, RatesContext, SnapshotPicker, money, problemMessage, rateColumns, rateText } from './components';
import { useFrozenSnapshots, useRates } from './hooks';
import { PAIRED_PATH, describeRates } from './model';
import type { RateGroup, Rates } from './model';
import './rates.css';

/**
 * DIS-12: the totals by unit with the two rates of each, and the day the Treasury figures are cut off (ST-DIS-010, FR-DIS-12, FR-DIS-19). Each unit row is made from the sums of its projects (BR-DIS-04):
 * 50/100 and 90/900 million are 14%, never the mean of 50% and 10%. The last row is the sum of all the units over the sum of all their plans. A unit leads to the projects of the unit on DIS-19.
 */
export default function UnitTotalsScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <UnitTotalsContent key={tenantId ?? 'none'} route={route} />;
}

function UnitTotalsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const snapshotId = params.get('snapshot') ?? '';
  const frozen = useFrozenSnapshots();
  // One request answers the row of each unit and the row of all of them: they are of one snapshot, whatever is frozen meanwhile.
  const total = useRates({ snapshotId, basis: 'CURRENT_YEAR', groupBy: 'UNIT' });
  const state = useScreenState({ isLoading: total.isLoading, error: total.error, data: total.data, isEmpty: (data) => data === undefined });
  const data = total.data;
  const failure = total.isError ? describeRates(total.error) : undefined;
  const choose = (next: string): void => {
    const value = new URLSearchParams(params);
    if (next === '') value.delete('snapshot');
    else value.set('snapshot', next);
    setParams(value, { replace: true });
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.unitTotals.page.title')}</h1>
          <p>{t('dis.unitTotals.page.subtitle')}</p>
        </div>
        {data === undefined ? null : <DefinitionBadge definition={data.definition} />}
      </div>
      <RatesContext snapshotId={data?.snapshotId} cutoff={data?.cutoffDate} />
      <FilterPanel unitLabel={t('dis.wr.unit')} applied={snapshotId === '' ? 0 : 1}>
        <div className="dis-filters">
          <SnapshotPicker id="totals-snapshot" value={snapshotId} onChange={choose} snapshots={frozen.data ?? []} />
        </div>
      </FilterPanel>
      {failure === undefined ? null : (
        <p className="w2dis-banner" role="alert" data-testid="rates-refusal">
          {problemMessage(t, failure)}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void total.refetch()}>
            {t('states.retry.action')}
          </button>
        </p>
      )}
      <StateBoundary state={failure === undefined ? state : 'default'} onRetry={() => void total.refetch()}>
        {data === undefined ? (
          <p className="w2dis-empty" data-testid="rates-none">
            {t('dis.rates.none.text')}
          </p>
        ) : (
          <SectionCard title={t('dis.unitTotals.table.title')} unit={t('dis.wr.unit')}>
            <p className="w2dis-note" data-testid="totals-cutoff">
              {t('dis.unitTotals.cutoff.text', { cutoff: data.cutoffDate })}
            </p>
            {data.groups.length === 0 ? (
              <p className="w2dis-empty" data-testid="totals-empty">
                {t('dis.unitTotals.table.empty.text')}
              </p>
            ) : (
              <UnitTable groups={data.groups} whole={data} />
            )}
          </SectionCard>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.unitTotals.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function UnitTable({ groups, whole }: { groups: readonly RateGroup[]; whole: Rates }) {
  const { t } = useTranslation();
  const planGroup = t('w2dis.rates.group.plan');
  const columns: DataTableColumn<RateGroup>[] = [
    {
      key: 'unit',
      header: t('dis.unitTotals.col.unit'),
      pinned: true,
      render: (group) => (
        <>
          {group.id === null ? <strong>{group.name ?? group.code}</strong> : <Link to={`${PAIRED_PATH}?snapshot=${whole.snapshotId}&unit=${group.id}`}>{group.name ?? group.code ?? group.id}</Link>}
          <span className="dis-code">{group.code}</span>
        </>
      ),
    },
    { key: 'projects', header: t('dis.rates.col.projects'), align: 'right', render: (group) => String(group.projects) },
    { key: 'planPm', header: t('dis.rates.col.planPm'), group: planGroup, align: 'right', render: (group) => money(group.planPmVnd) },
    { key: 'planLocal', header: t('dis.rates.col.planLocal'), group: planGroup, align: 'right', render: (group) => money(group.planLocalVnd) },
    { key: 'numerator', header: t('dis.rates.col.numerator'), align: 'right', render: (group) => money(group.numeratorVnd) },
    ...rateColumns<RateGroup>(t, (group) => ({ ratePmPct: group.ratePmPct, rateTotalPct: group.rateTotalPct, reason: group.nullReason })),
    { key: 'coverage', header: t('dis.rates.col.coverage'), render: (group) => <CoveragePill coverage={group.coverage} /> },
    { key: 'cutoff', header: t('dis.unitTotals.col.cutoff'), render: () => whole.cutoffDate },
  ];
  return (
    <DataTable
      caption={t('dis.unitTotals.table.aria')}
      columns={columns}
      rows={[...groups]}
      rowKey={(group) => group.id ?? group.code ?? 'row'}
      totalsLabel={t('dis.unitTotals.total.label')}
      totals={{
        projects: String(whole.projects),
        planPm: money(whole.planPmVnd),
        planLocal: money(whole.planLocalVnd),
        numerator: money(whole.numeratorVnd),
        ratePm: rateText(t, whole.ratePmPct, whole.nullReason),
        rateTotal: rateText(t, whole.rateTotalPct, whole.nullReason),
        coverage: <CoveragePill coverage={whole.coverage} />,
        cutoff: whole.cutoffDate,
      }}
    />
  );
}
