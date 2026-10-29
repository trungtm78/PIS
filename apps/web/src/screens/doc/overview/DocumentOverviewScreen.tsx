import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useOverview } from './hooks';
import { tileLabel } from './labels';
import { TEMPLATE_CXN, tileLink } from './model';
import type { Tile } from './model';
import './overview.css';

/**
 * DOC-01: the overview of the documents (ST-DOC-014, DOC.md). One tile for each queue of work: drafts to review, documents to be signed by the leader, to be numbered, to be sealed, incoming letters that are overdue,
 * errors of the interoperability and templates that wait for their legal confirmation. The numbers are the server's, counted over what the viewer may read at the moment shown; a tile the viewer may not count says so and is
 * never 0. Each tile leads to the list it counts.
 */
export default function DocumentOverviewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The numbers belong to one membership: a switch of tenant or of membership starts the screen over.
  return <OverviewContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OverviewContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const overview = useOverview();
  const state = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: () => overview.data?.tiles.length === 0 });
  const asOf = overview.data === undefined || overview.data.asOf === '' ? undefined : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(overview.data.asOf));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.overview.title')}</h1>
          <p>{t('doc.overview.subtitle')}</p>
        </div>
        <div className="actions">
          {asOf === undefined ? null : (
            <span className="sub" data-testid="as-of">
              {t('doc.overview.asOf', { time: asOf })}
            </span>
          )}
          <button type="button" disabled={overview.isFetching} onClick={() => void overview.refetch()}>
            {t('doc.overview.refresh')}
          </button>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void overview.refetch()}>
        <ul className="overview-grid" data-testid="tiles">
          {(overview.data?.tiles ?? []).map((tile) => (
            <TileView key={tile.key} tile={tile} />
          ))}
        </ul>
      </StateBoundary>
      <p className="prototype-note">{t('doc.overview.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function TileView({ tile }: { tile: Tile }) {
  const { t } = useTranslation();
  const link = tileLink(tile.key);
  return (
    <li className="overview-tile" data-tile={tile.key} data-testid={`tile-${tile.key}`}>
      <strong>{tileLabel(t, tile.key)}</strong>
      {tile.count === null ? (
        <span className="overview-count none sub" data-testid="count">
          {t('doc.overview.notPermitted')}
        </span>
      ) : (
        <span className="overview-count" data-testid="count">
          {tile.count}
        </span>
      )}
      {tile.key === 'templates_pending_confirmation' ? <small className="sub">{t('doc.overview.templates.cxn', { cxn: TEMPLATE_CXN })}</small> : null}
      {tile.key === 'interop_errors' ? <small className="sub">{t('doc.overview.interop.note')}</small> : null}
      {link === undefined || tile.count === null ? null : (
        <Link className="button" to={link}>
          {t('doc.overview.open')}
        </Link>
      )}
    </li>
  );
}
