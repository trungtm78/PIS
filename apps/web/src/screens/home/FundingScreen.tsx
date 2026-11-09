import { Link } from 'react-router-dom';
import { useEdition } from '../../editions/EditionContext';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, FilterPanel, KpiStrip, SectionCard } from '../../ui';
import { categoryLabel, originLabel } from '../cap/labels';
import '../dis/dis.css';
import './home.css';
import { FundTile, YearField, subsetLine } from './funding-components';
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
  // An edition that counts its capital in classes of its own (the enterprise: equity, loan, other) draws its own structure in place of the public sources.
  const EditionStructure = useEdition().slots?.fundingStructure;
  if (EditionStructure !== undefined) return <EditionStructure route={route} />;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <FundingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function FundingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const tenant = useSession().tenant;
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
          <div className="actions">
            <Link className="ui-button ui-button--outline" to={`${DETAIL_PATH}?year=${year}`}>
              {t('home.funding.detail.link')}
            </Link>
          </div>
        )}
      </div>
      <StateBoundary state={state} onRetry={() => void register.refetch()}>
        {funding === undefined ? null : (
          <div className="home-stack">
            <ContextBar items={[{ label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') }, { label: t('home.funding.year.label'), value: String(funding.year) }]} unit={t('w2dis.home.unit.billion')} />
            <FilterPanel unitLabel={t('w2dis.home.unit.billion')}>
              <YearField years={years} year={year} onChange={setYear} />
            </FilterPanel>
            <div data-testid="funding-total">
              <SectionCard title={t('home.funding.total.title', { year: funding.year })} unit={t('w2dis.home.unit.billion')}>
                <KpiStrip label={t('home.funding.total.title', { year: funding.year })}>
                  <FundTile label={t('w2dis.home.funding.total.label')} vnd={funding.totalVnd} testId="funding-total-amount" tone="success" />
                </KpiStrip>
                <p className="home-note">{t('home.funding.total.note')}</p>
              </SectionCard>
            </div>
            <div data-testid="funding-sources">
              <SectionCard title={t('home.funding.group.sources')} unit={t('w2dis.home.unit.billion')}>
                <KpiStrip label={t('home.funding.group.sources')}>
                  {funding.sources.map((card) => (
                    <SourceCardView key={card.category} card={card} locale={locale} />
                  ))}
                </KpiStrip>
              </SectionCard>
            </div>
            <div data-testid="funding-origins">
              <SectionCard title={t('home.funding.group.origins')} unit={t('w2dis.home.unit.billion')}>
                <KpiStrip label={t('home.funding.group.origins')}>
                  {funding.origins.map((card) => (
                    <OriginCardView key={card.origin} card={card} />
                  ))}
                </KpiStrip>
              </SectionCard>
            </div>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}

function SourceCardView({ card, locale }: { card: SourceCard; locale: string }) {
  const { t } = useTranslation();
  return (
    <FundTile label={categoryLabel(t, card.category)} vnd={card.vnd} card={card.category} testId={`source-${card.category}`}>
      {card.count === 0 ? null : <span className="home-fund-line">{t('home.funding.card.count', { count: card.count })}</span>}
      {card.subset === null ? null : (
        <span className="home-fund-line" data-testid={`subset-${card.category}`}>
          {subsetLine(t, card.subset.vnd, locale)}
          {card.subset.partial && card.subset.vnd !== null ? <small> {t('home.funding.subset.partial')}</small> : null}
        </span>
      )}
    </FundTile>
  );
}

function OriginCardView({ card }: { card: OriginCard }) {
  const { t } = useTranslation();
  return (
    <FundTile label={originLabel(t, card.origin)} vnd={card.vnd} card={card.origin} testId={`origin-${card.origin}`}>
      {card.count === 0 ? null : <span className="home-fund-line">{t('home.funding.card.count', { count: card.count })}</span>}
    </FundTile>
  );
}
