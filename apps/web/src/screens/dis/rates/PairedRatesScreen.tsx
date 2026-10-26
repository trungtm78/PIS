import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../dis.css';
import { RateCells, RateHeaders, RatePair, SnapshotPicker, coverageLabel, money, problemMessage } from './components';
import { useFrozenSnapshots, useRates } from './hooks';
import { FULL_TABLE_PATH, UNIT_TOTALS_PATH, describeRates } from './model';
import type { Basis } from './model';

/**
 * DIS-19: the two disbursement rates side by side over a frozen snapshot (ST-DIS-010, DIS 3 F6, BR-DIS-04, BR-DIS-05, BR-DIS-08). A pair of tiles for the scope, never one rate alone, with the formula and its
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
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.paired.page.title')}</h1>
          <p>{t('dis.paired.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
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
          <p className="sub" data-testid="paired-unit">
            {t('dis.paired.unit.text')}{' '}
            <button type="button" onClick={() => change('unit', '')}>
              {t('dis.paired.unit.clear.action')}
            </button>
          </p>
        )}
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
          <>
            <RatePair figures={data} definition={data.definition} cutoff={data.cutoffDate} basis={data.basis} />
            <section className="card" aria-labelledby="paired-table-title">
              <h2 id="paired-table-title">{t('dis.paired.table.title')}</h2>
              <p className="sub">
                <Link to={`${UNIT_TOTALS_PATH}?snapshot=${data.snapshotId}`}>{t('dis.paired.link.units')}</Link> · <Link to={`${FULL_TABLE_PATH}?snapshot=${data.snapshotId}`}>{t('dis.paired.link.full')}</Link>
              </p>
              <div className="tablewrap">
                <table className="table" aria-label={t('dis.paired.table.aria')} data-testid="paired-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('dis.rates.col.project')}</th>
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
                    </tr>
                  </thead>
                  <tbody>
                    {(total.data?.groups ?? []).map((group) => (
                      <tr key={group.id ?? group.code ?? 'row'} data-project={group.code ?? undefined}>
                        <td>
                          {group.code}
                          <span className="dis-code">{group.name}</span>
                        </td>
                        <td className="num">{money(group.planPmVnd)}</td>
                        <td className="num">{money(group.planLocalVnd)}</td>
                        <td className="num">{money(group.numeratorVnd)}</td>
                        <RateCells figures={group} />
                        <td>{coverageLabel(t, group.coverage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(total.data?.groups ?? []).length === 0 ? (
                <p className="muted" data-testid="paired-empty">
                  {t('dis.paired.table.empty.text')}
                </p>
              ) : null}
            </section>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.paired.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
