import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, SectionCard } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Field } from '../components';
import '../dis.css';
import { CoveragePill, RatesContext, RatePair, SnapshotPicker, money, problemMessage, rateColumns, rateText } from './components';
import { useFrozenSnapshots, useRates } from './hooks';
import { FULL_TABLE_PATH, UNIT_TOTALS_PATH, describeRates } from './model';
import type { Basis, RateGroup, Rates } from './model';
import './rates.css';

/**
 * DIS-19: the two disbursement rates side by side over a frozen snapshot (ST-DIS-010, DIS 3 F6, BR-DIS-04, BR-DIS-05, BR-DIS-08). A pair of tiles for the scope, never one rate alone, each with its denominator, the formula and its
 * reference (CXN-03) and the label that the formulas await the sign-off of D03; then a row for each project with the same pair and the Treasury coverage. The capital carried over is read apart on its own plan.
 */
export default function PairedRatesScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <PairedRatesContent key={tenantId ?? 'none'} route={route} />;
}

function PairedRatesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const snapshotId = params.get('snapshot') ?? '';
  const unitId = params.get('unit') ?? '';
  const basis: Basis = params.get('basis') === 'CARRYOVER' ? 'CARRYOVER' : 'CURRENT_YEAR';
  const frozen = useFrozenSnapshots();
  // One request answers the figures of the scope and the row of each project: the tiles and the rows are of one snapshot, whatever is frozen meanwhile.
  const total = useRates({ snapshotId, unitId, basis, groupBy: 'PROJECT' });
  const state = useScreenState({ isLoading: total.isLoading, error: total.error, data: total.data, isEmpty: (data) => data === undefined });
  const change = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const data = total.data;
  const failure = total.isError ? describeRates(total.error) : undefined;
  const applied = [snapshotId, unitId, basis === 'CARRYOVER' ? basis : ''].filter((value) => value !== '').length;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.paired.page.title')}</h1>
          <p>{t('dis.paired.page.subtitle')}</p>
        </div>
      </div>
      <RatesContext snapshotId={data?.snapshotId} cutoff={data?.cutoffDate} />
      <FilterPanel unitLabel={t('dis.wr.unit')} applied={applied}>
        <div className="dis-filters">
          <SnapshotPicker id="paired-snapshot" value={snapshotId} onChange={(next) => change('snapshot', next)} snapshots={frozen.data ?? []} />
          <Field id="paired-basis" label={t('dis.rates.basis.label')} error={undefined}>
            <select id="paired-basis" value={basis} onChange={(event) => change('basis', event.target.value === 'CARRYOVER' ? 'CARRYOVER' : '')}>
              <option value="CURRENT_YEAR">{t('dis.rates.basis.year')}</option>
              <option value="CARRYOVER">{t('dis.rates.basis.carryover')}</option>
            </select>
          </Field>
        </div>
        {unitId === '' ? null : (
          <p className="w2dis-note" data-testid="paired-unit">
            {t('dis.paired.unit.text')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => change('unit', '')}>
              {t('dis.paired.unit.clear.action')}
            </button>
          </p>
        )}
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
          <div className="w2dis-stack">
            <RatePair figures={data} definition={data.definition} cutoff={data.cutoffDate} basis={data.basis} />
            <SectionCard title={t('dis.paired.table.title')} unit={t('dis.wr.unit')}>
              <p className="w2dis-links">
                <Link to={`${UNIT_TOTALS_PATH}?snapshot=${data.snapshotId}`}>{t('dis.paired.link.units')}</Link>
                <Link to={`${FULL_TABLE_PATH}?snapshot=${data.snapshotId}`}>{t('dis.paired.link.full')}</Link>
              </p>
              {data.groups.length === 0 ? (
                <p className="w2dis-empty" data-testid="paired-empty">
                  {t('dis.paired.table.empty.text')}
                </p>
              ) : (
                <ProjectTable groups={data.groups} whole={data} />
              )}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.paired.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** A row for each project: the plans, the common numerator, the pair of rates and the Treasury coverage; the last row is the scope as the server added it up (sum over sum, never a mean of the rates). */
function ProjectTable({ groups, whole }: { groups: readonly RateGroup[]; whole: Rates }) {
  const { t } = useTranslation();
  const planGroup = t('w2dis.rates.group.plan');
  const columns: DataTableColumn<RateGroup>[] = [
    {
      key: 'project',
      header: t('dis.rates.col.project'),
      pinned: true,
      render: (group) => (
        <>
          <strong>{group.code}</strong>
          <span className="dis-code">{group.name}</span>
        </>
      ),
    },
    { key: 'planPm', header: t('dis.rates.col.planTtg'), group: planGroup, align: 'right', render: (group) => money(group.planPmVnd) },
    { key: 'planLocal', header: t('dis.rates.col.planLocal'), group: planGroup, align: 'right', render: (group) => money(group.planLocalVnd) },
    { key: 'numerator', header: t('dis.rates.col.disbursedTreasury'), align: 'right', render: (group) => money(group.numeratorVnd) },
    ...rateColumns<RateGroup>(t, (group) => ({ ratePmPct: group.ratePmPct, rateTotalPct: group.rateTotalPct, reason: group.nullReason })),
    { key: 'coverage', header: t('dis.rates.col.coverage'), render: (group) => <CoveragePill coverage={group.coverage} /> },
  ];
  return (
    <DataTable
      caption={t('dis.paired.table.aria')}
      columns={columns}
      rows={[...groups]}
      rowKey={(group) => group.id ?? group.code ?? 'row'}
      totalsLabel={t('dis.unitTotals.total.label')}
      totals={{
        planPm: money(whole.planPmVnd),
        planLocal: money(whole.planLocalVnd),
        numerator: money(whole.numeratorVnd),
        ratePm: rateText(t, whole.ratePmPct, whole.nullReason),
        rateTotal: rateText(t, whole.rateTotalPct, whole.nullReason),
        coverage: <CoveragePill coverage={whole.coverage} />,
      }}
    />
  );
}
