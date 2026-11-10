import { ApiError } from '@machvon/api-client';
import { Link } from 'react-router-dom';
import { useEdition } from '../../editions/EditionContext';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { SectionCard } from '../../ui';
import { FigureTile } from '../../screens/ban/components';
import { useWorkspace } from '../../screens/ban/hooks';
import { NO_FILTERS, PATH, PERMISSION, dayText, figureOf, may } from '../../screens/ban/model';

/** The four figures of the committee a leader reads standing up: the rate of the province, the gap to the curve, the projects that need attention and the directives that are overdue. */
const CARD_FIGURES = ['COMMITTEE_DISBURSEMENT_RATE', 'COMMITTEE_GAP_VS_CURVE', 'COMMITTEE_ATTENTION_PROJECTS', 'COMMITTEE_DIRECTIVES_OVERDUE'] as const;

/** The two of them that read against the plan the Prime Minister gave; an edition that draws its own plan reading (the enterprise) leaves them out. */
const PLAN_FIGURES = new Set<string>(['COMMITTEE_DISBURSEMENT_RATE', 'COMMITTEE_GAP_VS_CURVE']);

/**
 * The card of the committee workspace on the leader dashboard (BAN-1): the four figures of the head of the committee, each with its "i" and its flags, read from `getCommitteeWorkspace` on its own so that a failure of it never hides
 * the figures of the dashboard; a reader without the right to read the workspace is told the scope is hidden and nothing is asked of the server. Looking at it is a view of the workspace and is written to the audit of views like any other.
 */
export function CommitteeCard() {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const ownPlan = useEdition().slots?.homeFigures?.publicPlanBlocks === false;
  const allowed = may(permissions, PERMISSION.read);
  const query = useWorkspace(NO_FILTERS, allowed);
  const data = query.data;
  const denied = !allowed || (query.error instanceof ApiError && query.error.status === 403);
  return (
    <SectionCard title={t('ban.pwa.card.title')}>
      <div data-testid="pwa-committee">
        {denied ? (
          <p role="status" data-testid="pwa-committee-denied">
            {t('ban.pwa.card.denied')}
          </p>
        ) : query.isLoading ? (
          <div role="status" aria-busy="true" aria-label={t('ban.pwa.card.loading')}>
            <span className="ui-skeleton ui-skeleton--line" />
            <span className="ui-skeleton ui-skeleton--line" />
            <span className="ui-skeleton ui-skeleton--line" />
          </div>
        ) : data === undefined ? (
          <p role="alert">
            {t('ban.pwa.card.error')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
              {t('ui.common.retry')}
            </button>
          </p>
        ) : (
          <>
            {data.feed.empty ? <p role="status">{t('ban.pwa.card.noFeed')}</p> : null}
            <section className="ban-figures" aria-label={t('ban.pwa.card.aria')}>
              {CARD_FIGURES.flatMap((code) => {
                if (ownPlan && PLAN_FIGURES.has(code)) return [];
                const tile = figureOf(data.figures, code);
                return tile === undefined ? [] : [<FigureTile key={code} tile={tile} />];
              })}
            </section>
            <p className="sub">{t('ban.pwa.card.asOf', { day: dayText(data.as_of) })}</p>
          </>
        )}
        <p>
          <Link className="ui-button ui-button--outline pwa-touch" to={PATH.dashboard} data-testid="pwa-committee-link">
            {t('ban.pwa.card.link')}
          </Link>
        </p>
      </div>
    </SectionCard>
  );
}
