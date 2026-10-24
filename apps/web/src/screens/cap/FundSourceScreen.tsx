import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Citation, Money, OriginBadge } from './components';
import { useAppropriations } from './hooks';
import { categoryLabel, levelLabel } from './labels';
import { BOOK_PATH, fundTree, sumVnd } from './model';
import type { FundNode } from './model';
import './cap.css';

/**
 * CAP-04: the fund sources the capital is drawn from, as a tree: the category (NSTW, NSĐP, ODA), the fund source with its validity and the
 * capital published for it, by origin. CTMTQG is part of its parent source and is never added again, so it has no total of its own.
 */
export default function FundSourceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <FundContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function FundContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const book = useAppropriations();
  const tree = useMemo(() => fundTree(book.data ?? []), [book.data]);
  const published = useMemo(() => (book.data ?? []).filter((line) => line.status === 'PUBLISHED'), [book.data]);
  const state = useScreenState({ isLoading: book.isLoading, error: book.error, data: published });
  const grand = sumVnd(tree.map((category) => category.totals.amountVnd));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.fund.page.title')}</h1>
          <p>{t('cap.fund.page.subtitle')}</p>
        </div>
        <Link className="button" to={BOOK_PATH}>
          {t('cap.fund.book.link')}
        </Link>
      </div>
      <StateBoundary state={state} onRetry={() => void book.refetch()}>
        <div className="card">
          <p className="callout" role="note">
            {t('cap.fund.ctmtqg.note')}
          </p>
          <ul className="cap-tree" aria-label={t('cap.fund.tree.aria')} data-testid="tree">
            {tree.map((category) => (
              <li key={category.category} data-category={category.category}>
                <details open>
                  <summary>
                    <strong>{categoryLabel(t, category.category)}</strong> <Money vnd={category.totals.amountVnd} />
                  </summary>
                  <ul>
                    {category.sources.map((source) => (
                      <SourceNode key={source.fundSource.versionId} source={source} />
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <p className="cap-grand" data-testid="grand-total">
            {t('cap.fund.total.label')} <Money vnd={grand} />
          </p>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('cap.fund.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function SourceNode({ source }: { source: FundNode }) {
  const { t } = useTranslation();
  const { fundSource } = source;
  return (
    <li data-fund-source={fundSource.businessKey}>
      <p>
        <strong>{fundSource.businessKey}</strong> {fundSource.label}{' '}
        <small className="sub">
          {fundSource.validUntil === null ? t('cap.fund.validity.open', { from: fundSource.validFrom }) : t('cap.fund.validity.range', { from: fundSource.validFrom, until: fundSource.validUntil })}
        </small>
        {fundSource.category === 'ODA' && fundSource.onLending !== null ? (
          <span className="cap-badge" data-testid="onlending">
            {fundSource.onLending ? t('cap.fund.oda.lent.label') : t('cap.fund.oda.grant.label')}
          </span>
        ) : null}{' '}
        <Money vnd={source.totals.amountVnd} />
      </p>
      <ul>
        {source.groups.map((group) =>
          group.lines.map((line) => (
            <li key={line.id} data-appropriation-id={line.id}>
              <OriginBadge origin={line.origin} /> {levelLabel(t, line.budgetLevel)} · {line.planYear} · <Citation line={line} /> · <Money vnd={line.amountVnd} />{' '}
              <small className="sub">
                {t('cap.fund.line.remaining.label')} <Money vnd={line.remainingVnd} />
              </small>
            </li>
          )),
        )}
      </ul>
    </li>
  );
}
