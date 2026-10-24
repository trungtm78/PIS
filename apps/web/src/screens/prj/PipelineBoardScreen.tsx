import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { NationalCode } from './components';
import { stageLabel } from './labels';
import { amountText, workspaceLink } from './model';
import type { ProjectStatus } from './model';
import { useBoardColumn } from './pipeline-hooks';
import { ENDED_STAGES, OPEN_STAGES, PROJECT_GROUPS, canOpenMoves, cardsOf } from './pipeline-model';
import type { BoardCard, ProjectGroup } from './pipeline-model';
import { StageDialog } from './StageDialog';
import './prj.css';

/** PRJ-14: the project bank as a board, a column for each stage of the PIMA life cycle; a project moves only through the guarded commands. */
export default function PipelineBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <Board key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function Board({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [group, setGroup] = useState<ProjectGroup | ''>('');
  const [showEnded, setShowEnded] = useState(false);
  const [moving, setMoving] = useState<BoardCard | undefined>(undefined);
  // The read of the bank is one permission for every column: when the server refuses it, the whole board is the standard card of a refusal.
  const [denied, setDenied] = useState(false);
  const markDenied = useCallback(() => setDenied(true), []);
  const canMove = canOpenMoves(permissions, mode);
  const stages: readonly ProjectStatus[] = showEnded ? [...OPEN_STAGES, ...ENDED_STAGES] : OPEN_STAGES;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.board.page.title')}</h1>
          <p>{t('prj.board.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={denied ? 'denied' : 'default'}>
        <p className="callout" role="note" data-testid="drag-disabled">
          {t('prj.board.dragDisabled.notice')}
        </p>
        <form className="prj-filters" role="search" aria-label={t('prj.board.filters.title')} onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="board-group">{t('prj.board.group.label')}</label>
            <select id="board-group" value={group} onChange={(event) => setGroup(event.target.value as ProjectGroup | '')}>
              <option value="">{t('prj.board.group.all')}</option>
              {PROJECT_GROUPS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} />
            {t('prj.board.ended.toggle')}
          </label>
        </form>
        <div className="prj-board" data-testid="board">
          {stages.map((stage) => (
            <Column key={stage} stage={stage} group={group} canMove={canMove} onMove={setMoving} onDenied={markDenied} />
          ))}
        </div>
      </StateBoundary>
      {moving === undefined ? null : <StageDialog key={moving.id} card={moving} onClose={() => setMoving(undefined)} />}
      <p className="prototype-note">{t('prj.board.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface ColumnProps {
  stage: ProjectStatus;
  group: ProjectGroup | '';
  canMove: boolean;
  onMove(card: BoardCard): void;
  onDenied(): void;
}

function Column({ stage, group, canMove, onMove, onDenied }: ColumnProps) {
  const { t } = useTranslation();
  const column = useBoardColumn(stage, group);
  const state = useScreenState({ isLoading: column.isLoading, error: column.error });
  useEffect(() => {
    if (state === 'denied') onDenied();
  }, [state, onDenied]);
  const pages = column.data?.pages ?? [];
  const cards = cardsOf(pages);
  const total = pages[0]?.total ?? 0;
  const label = stageLabel(t, stage);
  return (
    <section className="prj-column" aria-label={t('prj.board.column.aria', { stage: label })} data-stage={stage}>
      <header className="prj-column-head">
        <h2>{label}</h2>
        <span className="prj-badge" data-testid="column-count">
          {t('prj.board.column.count', { count: total })}
        </span>
      </header>
      {column.isLoading ? (
        <p role="status">{t('prj.board.column.loading')}</p>
      ) : column.isError ? (
        <div className="callout warning" role="alert">
          <p>{t('prj.board.column.error')}</p>
          <button type="button" onClick={() => void column.refetch()}>
            {t('prj.board.column.retry')}
          </button>
        </div>
      ) : cards.length === 0 ? (
        <p className="sub" data-testid="column-empty">
          {t('prj.board.column.empty')}
        </p>
      ) : (
        <ul className="prj-cards">
          {cards.map((card) => (
            <Card key={card.id} card={card} canMove={canMove} onMove={onMove} />
          ))}
        </ul>
      )}
      {column.hasNextPage ? (
        <button type="button" disabled={column.isFetchingNextPage} onClick={() => void column.fetchNextPage()}>
          {t('prj.board.column.more')}
        </button>
      ) : null}
    </section>
  );
}

/** A card, collapsed to the figures that decide the next step; the button opens the confirmation of a move (dragging is not offered). */
function Card({ card, canMove, onMove }: { card: BoardCard; canMove: boolean; onMove(card: BoardCard): void }) {
  const { t, locale } = useTranslation();
  const ended = ENDED_STAGES.includes(card.status);
  return (
    <li className="prj-card" data-project-id={card.id}>
      <Link to={workspaceLink(card.id)}>{card.code}</Link>
      <span className="prj-card-name">{card.name}</span>
      <dl className="prj-facts">
        <dt>{t('prj.board.card.investment.label')}</dt>
        <dd>{t('prj.workspace.value.amount', { amount: amountText(card.totalInvestmentVnd, locale) })}</dd>
        <dt>{t('prj.board.card.group.label')}</dt>
        <dd>{card.projectGroup ?? t('prj.list.group.none')}</dd>
        <dt>{t('prj.board.card.score.label')}</dt>
        <dd>{card.appraisalScore ?? t('prj.board.card.score.none')}</dd>
        <dt>{t('prj.board.card.leader.label')}</dt>
        <dd>{card.leaderName ?? t('prj.list.leader.none')}</dd>
      </dl>
      <p className="prj-card-badges">
        <NationalCode code={card.nationalProjectCode} />
        {card.capitalReady === null ? null : (
          <span className={card.capitalReady ? 'prj-badge' : 'prj-badge warning'} data-testid="capital-ready">
            {card.capitalReady ? t('prj.board.card.ready.badge') : t('prj.board.card.notReady.badge')}
          </span>
        )}
      </p>
      {canMove && !ended ? (
        <button type="button" aria-label={t('prj.board.card.move.aria', { code: card.code })} onClick={() => onMove(card)}>
          {t('prj.board.card.move.action')}
        </button>
      ) : null}
    </li>
  );
}
