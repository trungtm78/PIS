import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { categoryLabel, originLabel } from '../cap/labels';
import '../dis/dis.css';
import { Amount, YearField, subsetLine } from './funding-components';
import { useFunding } from './funding-hooks';
import type { OriginCard, SourceCard } from './funding-model';

const DETAIL_PATH = '/home/home-08';

/**
 * HOME-07: the funding structure (ST-HOME-005, HOME 3 F6): the capital published for a year, in cards by source (NSTW, NSDP, ODA, the others) and by origin (the Prime Minister's, added by the
 * province, carried over, support, the NSTW revenue increase). CTMTQG is shown as "of which" under NSTW, from the plan lines, and is in no total; what has no figure says "no data" and is never zero.
 * Read-only, from the register of CAP; HOME keeps no table of it.
 */
export default function FundingScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <FundingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function FundingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { register, years, year, funding, setYear } = useFunding();
  const state = useScreenState({ isLoading: register.isLoading, error: register.error, data: register.data === undefined ? undefined : years });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.funding.page.title')}</h1>
          <p>{t('home.funding.page.subtitle')}</p>
        </div>
        {year === undefined ? null : (
          <Link className="button" to={`${DETAIL_PATH}?year=${year}`}>
            {t('home.funding.detail.link')}
          </Link>
        )}
      </div>
      <StateBoundary state={state} onRetry={() => void register.refetch()}>
        {funding === undefined ? null : (
          <>
            <div className="card">
              <YearField years={years} year={year} onChange={setYear} />
            </div>
            <section className="card" aria-labelledby="funding-total-title" data-testid="funding-total">
              <h2 id="funding-total-title">{t('home.funding.total.title', { year: funding.year })}</h2>
              <p>
                <Amount vnd={funding.totalVnd} testId="funding-total-amount" />
              </p>
              <p className="sub">{t('home.funding.total.note')}</p>
            </section>
            <section aria-labelledby="funding-sources-title" data-testid="funding-sources">
              <h2 id="funding-sources-title">{t('home.funding.group.sources')}</h2>
              <div className="dis-rate-pair">
                {funding.sources.map((card) => (
                  <SourceCardView key={card.category} card={card} locale={locale} />
                ))}
              </div>
            </section>
            <section aria-labelledby="funding-origins-title" data-testid="funding-origins">
              <h2 id="funding-origins-title">{t('home.funding.group.origins')}</h2>
              <div className="dis-rate-pair">
                {funding.origins.map((card) => (
                  <OriginCardView key={card.origin} card={card} />
                ))}
              </div>
            </section>
          </>
        )}
      </StateBoundary>
    </section>
  );
}

function SourceCardView({ card, locale }: { card: SourceCard; locale: string }) {
  const { t } = useTranslation();
  return (
    <section className="card" data-card={card.category} aria-label={categoryLabel(t, card.category)}>
      <h3>{categoryLabel(t, card.category)}</h3>
      <p>
        <Amount vnd={card.vnd} testId={`source-${card.category}`} />
      </p>
      {card.count === 0 ? null : <p className="sub">{t('home.funding.card.count', { count: card.count })}</p>}
      {card.subset === null ? null : (
        <p data-testid={`subset-${card.category}`}>
          {subsetLine(t, card.subset.vnd, locale)}
          {card.subset.partial && card.subset.vnd !== null ? <small className="sub"> {t('home.funding.subset.partial')}</small> : null}
        </p>
      )}
    </section>
  );
}

function OriginCardView({ card }: { card: OriginCard }) {
  const { t } = useTranslation();
  return (
    <section className="card" data-card={card.origin} aria-label={originLabel(t, card.origin)}>
      <h3>{originLabel(t, card.origin)}</h3>
      <p>
        <Amount vnd={card.vnd} testId={`origin-${card.origin}`} />
      </p>
      {card.count === 0 ? null : <p className="sub">{t('home.funding.card.count', { count: card.count })}</p>}
    </section>
  );
}
