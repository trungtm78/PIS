import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../dis.css';
import { DefinitionBadge, RateCells, RateHeaders, SnapshotPicker, coverageLabel, money, problemMessage } from './components';
import { useFrozenSnapshots, useRates } from './hooks';
import { PAIRED_PATH, describeRates } from './model';

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
      <div className="card">
        <div className="dis-filters">
          <SnapshotPicker id="totals-snapshot" value={snapshotId} onChange={choose} snapshots={frozen.data ?? []} />
        </div>
      </div>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="rates-refusal">
          {problemMessage(t, failure)}{' '}
          <button type="button" onClick={() => void total.refetch()}>
            {t('states.retry.action')}
          </button>
        </p>
      )}
      <StateBoundary state={failure === undefined ? state : 'default'} onRetry={() => void total.refetch()}>
        {data === undefined ? (
          <p className="muted" data-testid="rates-none">
            {t('dis.rates.none.text')}
          </p>
        ) : (
          <section className="card" aria-labelledby="totals-table-title">
            <h2 id="totals-table-title">{t('dis.unitTotals.table.title')}</h2>
            <p className="sub" data-testid="totals-cutoff">
              {t('dis.unitTotals.cutoff.text', { cutoff: data.cutoffDate })}
            </p>
            <div className="tablewrap">
              <table className="table" aria-label={t('dis.unitTotals.table.aria')} data-testid="totals-table">
                <thead>
                  <tr>
                    <th scope="col">{t('dis.unitTotals.col.unit')}</th>
                    <th scope="col" className="num">
                      {t('dis.rates.col.projects')}
                    </th>
                    <th scope="col" className="num">
                      {t('dis.rates.col.planPm')}
                    </th>
                    <th scope="col" className="num">
                      {t('dis.rates.col.planLocal')}
                    </th>
                    <th scope="col" className="num">
                      {t('dis.rates.col.numerator')}
                    </th>
                    <RateHeaders />
                    <th scope="col">{t('dis.rates.col.coverage')}</th>
                    <th scope="col">{t('dis.unitTotals.col.cutoff')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(total.data?.groups ?? []).map((group) => (
                    <tr key={group.id ?? group.code ?? 'row'} data-unit={group.id ?? undefined}>
                      <td>
                        {group.id === null ? (
                          (group.name ?? group.code)
                        ) : (
                          <Link to={`${PAIRED_PATH}?snapshot=${data.snapshotId}&unit=${group.id}`}>{group.name ?? group.code ?? group.id}</Link>
                        )}
                        <span className="dis-code">{group.code}</span>
                      </td>
                      <td className="num">{group.projects}</td>
                      <td className="num">{money(group.planPmVnd)}</td>
                      <td className="num">{money(group.planLocalVnd)}</td>
                      <td className="num">{money(group.numeratorVnd)}</td>
                      <RateCells figures={group} />
                      <td>{coverageLabel(t, group.coverage)}</td>
                      <td>{data.cutoffDate}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="totals-row">
                    <th scope="row">{t('dis.unitTotals.total.label')}</th>
                    <td className="num">{data.projects}</td>
                    <td className="num">{money(data.planPmVnd)}</td>
                    <td className="num">{money(data.planLocalVnd)}</td>
                    <td className="num">{money(data.numeratorVnd)}</td>
                    <RateCells figures={data} />
                    <td>{coverageLabel(t, data.coverage)}</td>
                    <td>{data.cutoffDate}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {(total.data?.groups ?? []).length === 0 ? (
              <p className="muted" data-testid="totals-empty">
                {t('dis.unitTotals.table.empty.text')}
              </p>
            ) : null}
          </section>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.unitTotals.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
