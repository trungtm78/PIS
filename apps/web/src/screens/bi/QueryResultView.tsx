import { useTranslation } from '../../i18n';
import { badgeLabel, dimensionLabel } from './labels';
import { formatFigure } from './query-model';
import type { Group, QueryResult } from './query-model';

/** The labels every number of BI carries (BR-BI-04): the period, the snapshot, the quality of the data, whether it came from the cache, and whose scope it is. */
export function ResultLabels({ result }: { result: QueryResult }) {
  const { t } = useTranslation();
  return (
    <ul className="mne-lines" data-testid="result-labels">
      <li data-testid="label-period">{t('bi.query.label.period', { period: result.asOfPeriod })}</li>
      <li data-testid="label-snapshot">{t('bi.query.label.snapshot', { id: result.snapshotId.slice(0, 8) })}</li>
      <li data-testid="label-quality" data-badge={result.badge}>
        {t('bi.query.label.quality')}: {badgeLabel(t, result.badge)}
        {result.feedsCertified ? null : <span className="sub"> {t('bi.versions.notCertified')}</span>}
      </li>
      <li data-testid="label-cache">{result.servedFromCache ? t('bi.query.label.cached', { at: result.builtAt }) : t('bi.query.label.fresh', { at: result.builtAt })}</li>
      <li data-testid="label-scope" data-scope={result.scopeLabel}>
        {result.scopeLabel === 'YOUR_SCOPE' ? t('bi.query.label.yourScope') : t('bi.query.label.fullTenant')}
      </li>
      {result.excludedQuarantineRows > 0 ? <li>{t('bi.versions.excluded', { rows: result.excludedQuarantineRows })}</li> : null}
    </ul>
  );
}

/** The table of the groups of an answer with its total, and whether the groups add up to it (and why not). */
export function GroupTable({ result, onDrill }: { result: QueryResult; onDrill?: ((group: Group) => void) | undefined }) {
  const { t, locale } = useTranslation();
  const words = { noData: t('bi.query.noData'), notApplicable: t('bi.query.notApplicable') };
  const ratio = result.aggregationType === 'ratio';
  return (
    <table className="table" data-testid="group-table" aria-label={t('bi.query.table.aria')}>
      <thead>
        <tr>
          <th scope="col">{result.dimension === null ? t('bi.query.column.metric') : dimensionLabel(t, result.dimension)}</th>
          <th scope="col">{t('bi.query.column.value')}</th>
          {ratio ? <th scope="col">{t('bi.query.column.numerator')}</th> : null}
          {ratio ? <th scope="col">{t('bi.query.column.denominator')}</th> : null}
          {onDrill === undefined ? null : <th scope="col">{t('bi.query.column.drill')}</th>}
        </tr>
      </thead>
      <tbody>
        {result.children.map((group) => (
          <tr key={group.key ?? 'unclassified'} data-group={group.key ?? 'unclassified'}>
            <td>{group.unclassified ? t('bi.query.unclassified') : group.label}</td>
            <td data-testid={`value-${group.key ?? 'unclassified'}`}>{formatFigure(group, ratio ? 'percent' : result.unit, locale, words)}</td>
            {ratio ? <td>{group.numerator ?? t('bi.query.noData')}</td> : null}
            {ratio ? <td>{group.denominator ?? t('bi.query.noData')}</td> : null}
            {onDrill === undefined ? null : (
              <td>
                {group.drillToken === null ? null : (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onDrill(group)}>
                    {t('bi.query.drill.action')}
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr data-testid="group-total">
          <th scope="row">{t('bi.query.total')}</th>
          <td>{formatFigure(result.total, ratio ? 'percent' : result.unit, locale, words)}</td>
          {ratio ? <td>{result.total.numerator ?? t('bi.query.noData')}</td> : null}
          {ratio ? <td>{result.total.denominator ?? t('bi.query.noData')}</td> : null}
          {onDrill === undefined ? null : <td />}
        </tr>
      </tfoot>
    </table>
  );
}

export function Reconciliation({ result }: { result: QueryResult }) {
  const { t } = useTranslation();
  if (result.dimension === null || result.children.length === 0) return null;
  return result.reconcilesToParent ? (
    <p className="pill" data-testid="reconciles" data-reconciles="true">
      {t('bi.query.reconciles')}
    </p>
  ) : (
    <p className="pill warn" data-testid="reconciles" data-reconciles="false">
      {result.nonAdditiveReason === 'DISTINCT_NOT_ADDITIVE' ? t('bi.query.notAdditive.distinct') : t('bi.query.notAdditive.other')}
    </p>
  );
}
