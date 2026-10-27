import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { categoryLabel, originLabel } from '../cap/labels';
import { vndText } from '../cap/model';
import '../dis/dis.css';
import { YearField } from './funding-components';
import { useFunding } from './funding-hooks';

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
  const { register, years, year, funding, setYear } = useFunding();
  const state = useScreenState({ isLoading: register.isLoading, error: register.error, data: register.data === undefined ? undefined : years });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.funding.detail.title')}</h1>
          <p>{t('home.funding.detail.subtitle')}</p>
        </div>
        <Link className="button" to={year === undefined ? OVERVIEW_PATH : `${OVERVIEW_PATH}?year=${year}`}>
          {t('home.funding.detail.back')}
        </Link>
      </div>
      <StateBoundary state={state} onRetry={() => void register.refetch()}>
        {funding === undefined ? null : (
          <>
            <div className="card">
              <YearField years={years} year={year} onChange={setYear} />
            </div>
            <section className="card" aria-labelledby="funding-table-title">
              <h2 id="funding-table-title">{t('home.funding.detail.table', { year: funding.year })}</h2>
              <table className="table" data-testid="funding-table" aria-label={t('home.funding.detail.table', { year: funding.year })}>
                <thead>
                  <tr>
                    <th scope="col">{t('home.funding.detail.column.source')}</th>
                    <th scope="col">{t('home.funding.detail.column.category')}</th>
                    <th scope="col">{t('home.funding.detail.column.origin')}</th>
                    <th scope="col">{t('home.funding.detail.column.amount')}</th>
                    <th scope="col">{t('home.funding.detail.column.relation')}</th>
                    <th scope="col">{t('home.funding.detail.column.cutoff')}</th>
                  </tr>
                </thead>
                <tbody>
                  {funding.rows.map((row) => (
                    <tr key={row.key} data-row={row.key} data-subset={row.subsetOf === null ? 'false' : 'true'}>
                      <td>{row.label}</td>
                      <td>{categoryLabel(t, row.category)}</td>
                      <td>{row.origin === null ? '' : originLabel(t, row.origin)}</td>
                      <td className="num">{vndText(row.vnd, locale)}</td>
                      <td>{row.subsetOf === null ? t('home.funding.detail.relation.independent') : t('home.funding.detail.relation.subset')}</td>
                      <td>{row.cutOff ?? t('home.funding.detail.cutoff.none')}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid="funding-table-total">
                    <th scope="row" colSpan={3}>
                      {t('home.funding.detail.total')}
                    </th>
                    <td className="num">{funding.totalVnd === null ? t('home.funding.card.none') : vndText(funding.totalVnd, locale)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </section>
            <section className="card" aria-labelledby="funding-scope-title" data-testid="funding-scope">
              <h2 id="funding-scope-title">{t('home.funding.scope.title')}</h2>
              <ul className="mne-lines">
                <li>{t('home.funding.scope.published', { year: funding.year })}</li>
                <li>{t('home.funding.scope.subset')}</li>
                <li>{t('home.funding.scope.cutoff')}</li>
              </ul>
            </section>
          </>
        )}
      </StateBoundary>
    </section>
  );
}
