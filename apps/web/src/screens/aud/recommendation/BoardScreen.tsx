import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, FilterPanel, KpiStrip, KpiTile, StatusPill } from '../../../ui';
import '../aud.css';
import { recommendationStatusLabel, recommendationTypeLabel } from '../conclusion/labels';
import { todayInVietnam } from '../model';
import { DueDay, EngagementFilter, Money, useCaller } from './components';
import { CompleteDialog, DecisionDialog, DisputeDialog, EvidenceDialog, PlanDialog, SubmitDialog, VerifyDialog } from './dialogs';
import { useRecommendationBoard } from './hooks';
import { actionStatusLabel, disputeOutcomeLabel } from './labels';
import { BOARD_COLUMNS, RECOMMENDATIONS_PATH, canAttach, canComplete, canDecide, canDispute, canPlan, canSubmit, canVerify, inColumn, lateDays } from './model';
import type { ActionItem, BoardColumn, BoardItem, Caller } from './model';

type Dialog =
  | { kind: 'plan' | 'submit' | 'dispute' | 'decide' | 'verify' | 'evidence'; item: BoardItem }
  | { kind: 'complete'; item: BoardItem; action: ActionItem };

/**
 * AUD-07: the follow-up of the recommendations as a board (ST-AUD-003, AUD 3.3): one column for each stage the work goes through, one card for each recommendation with its owner, its day, the
 * days it is late, its actions and their evidence. The board changes nothing by itself: a card does not move by dragging, the buttons of the owner and of the verifier are the commands, and the
 * server decides again on each. The data are confidential: only the recommendations of the engagements in the scope of the caller, and the ones given to them, are here.
 */
export default function BoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const caller = useCaller();
  const [params] = useSearchParams();
  const engagementId = params.get('engagement') ?? undefined;
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const list = useRecommendationBoard({ engagementId, status: '', type: '' });
  // The board keeps its columns when there are no cards: the empty words are the column's, not the screen's.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const today = todayInVietnam();
  const close = (): void => setDialog(undefined);
  const all = list.data ?? [];
  const active = all.filter((item) => item.status !== 'CLOSED' && item.status !== 'CANCELLED');
  const late = all.filter((item) => lateDays(item, today) > 0);
  const disputed = all.filter((item) => item.status === 'DISPUTED');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.remediation.board.title')}</h1>
          <p>{t('aud.remediation.board.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') }]} unit={t('w2iss.aud.unit')} />
      <p className="callout" data-testid="confidential-note">
        {t('aud.remediation.confidential.note')}
      </p>
      <FilterPanel
        applied={engagementId === undefined ? 0 : 1}
        actions={
          <Link className="ui-button ui-button--outline" to={RECOMMENDATIONS_PATH + (engagementId === undefined ? '' : `?engagement=${engagementId}`)}>
            {t('aud.remediation.board.list.link')}
          </Link>
        }
      >
        <div className="aud-filters">
          <EngagementFilter selected={engagementId} />
        </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <KpiStrip label={t('w2iss.aud.board.kpi.label')}>
          <KpiTile label={t('w2iss.aud.board.kpi.active')} value={String(active.length)} />
          <KpiTile label={t('w2iss.aud.board.kpi.late')} value={String(late.length)} tone={late.length > 0 ? 'danger' : 'default'} />
          <KpiTile label={t('w2iss.aud.board.kpi.disputed')} value={String(disputed.length)} tone={disputed.length > 0 ? 'warning' : 'default'} />
        </KpiStrip>
        <p className="sub" data-testid="board-legend">
          {t('aud.remediation.board.legend')}
        </p>
        <div className="aud-board" data-testid="board">
          {BOARD_COLUMNS.map((column) => (
            <Column key={column} column={column} items={inColumn(list.data ?? [], column)} caller={caller} today={today} onDialog={setDialog} />
          ))}
        </div>
      </StateBoundary>
      {dialog?.kind === 'plan' ? <PlanDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'submit' ? <SubmitDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'dispute' ? <DisputeDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'decide' ? <DecisionDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'verify' ? <VerifyDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'evidence' ? <EvidenceDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'complete' ? <CompleteDialog item={dialog.item} action={dialog.action} onClose={close} /> : null}
      <p className="prototype-note">{t('aud.remediation.board.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Column({ column, items, caller, today, onDialog }: { column: BoardColumn; items: BoardItem[]; caller: Caller; today: string; onDialog(dialog: Dialog): void }) {
  const { t } = useTranslation();
  return (
    <section className="aud-column" data-column={column} aria-label={recommendationStatusLabel(t, column)}>
      <h2>
        {recommendationStatusLabel(t, column)} <span className="aud-badge">{items.length}</span>
      </h2>
      {items.length === 0 ? <p className="muted">{t('aud.remediation.board.empty.text')}</p> : null}
      {items.map((item) => (
        <Card key={item.id} item={item} caller={caller} today={today} onDialog={onDialog} />
      ))}
    </section>
  );
}

function Card({ item, caller, today, onDialog }: { item: BoardItem; caller: Caller; today: string; onDialog(dialog: Dialog): void }) {
  const { t } = useTranslation();
  // A recommendation that is past its day needs action; the board does not carry an escalation, so none is marked urgent here.
  const stripe = lateDays(item, today) > 0 ? 'ACTION' : null;
  return (
    <article className="card aud-card" aria-label={t('aud.remediation.card.label', { code: item.code })} data-recommendation-id={item.id} {...(stripe === null ? {} : { 'data-stripe': stripe })}>
      {stripe === null ? null : <span className="ui-sr-only">{t('ui.dataTable.severityPrefix', { label: t('ui.dataTable.severity.action') })}. </span>}
      <p>
        <StatusPill tone="neutral">{recommendationTypeLabel(t, item.type)}</StatusPill>
      </p>
      <h3>{item.code}</h3>
      <p className="aud-words">{item.description}</p>
      <dl className="aud-facts">
        <dt>{t('aud.remediation.card.owner')}</dt>
        <dd>{item.ownerUser !== null ? item.ownerUser.name : item.ownerUnit !== null ? item.ownerUnit.name : t('aud.remediation.owner.none')}</dd>
        <dt>{t('aud.remediation.card.dueLate')}</dt>
        <dd>
          <DueDay item={item} today={today} countdown />
        </dd>
        <dt>{t('aud.remediation.card.money')}</dt>
        <dd>
          <Money item={item} />
        </dd>
        <dt>{t('aud.remediation.card.evidence')}</dt>
        <dd>{t('aud.remediation.card.evidence.count', { count: item.evidenceCount })}</dd>
      </dl>
      {item.status === 'DISPUTED' && item.disputeReason !== null ? (
        <p className="callout" data-testid="dispute-note">
          <strong>{t('aud.remediation.card.dispute')}</strong> {item.disputeReason}
        </p>
      ) : null}
      {item.disputeOutcome === null || item.status === 'DISPUTED' ? null : <p className="sub">{disputeOutcomeLabel(t, item.disputeOutcome)}</p>}
      {item.verificationNote !== null && item.status !== 'CLOSED' ? (
        <p className="callout warning" data-testid="return-note">
          <strong>{t('aud.remediation.card.returned')}</strong> {item.verificationNote}
        </p>
      ) : null}
      {item.actions.length === 0 ? null : (
        <ul className="aud-actions" aria-label={t('aud.remediation.card.actions')}>
          {item.actions.map((action) => (
            <li key={action.id} data-action-id={action.id}>
              <span>
                <strong>{action.code}</strong> {action.description}
              </span>
              <span className="sub">
                {actionStatusLabel(t, action.status)}
                {action.completedOn === null ? ` · ${t('aud.remediation.card.planned', { day: action.plannedOn })}` : ` · ${action.completedOn}`}
                {action.evidenceDocumentId === null ? '' : ` · ${t('aud.remediation.card.evidence.shown')}`}
              </span>
              {canComplete(item, action, caller) ? (
                <button type="button" onClick={() => onDialog({ kind: 'complete', item, action })}>
                  {t('aud.remediation.complete.action')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="aud-row-actions">
        {canPlan(item, caller) ? (
          <button type="button" onClick={() => onDialog({ kind: 'plan', item })}>
            {t('aud.remediation.plan.action')}
          </button>
        ) : null}
        {canSubmit(item, caller) ? (
          <button type="button" className="primary" onClick={() => onDialog({ kind: 'submit', item })}>
            {t('aud.remediation.submit.action')}
          </button>
        ) : null}
        {canDispute(item, caller) ? (
          <button type="button" onClick={() => onDialog({ kind: 'dispute', item })}>
            {t('aud.remediation.dispute.action')}
          </button>
        ) : null}
        {canAttach(item, caller) ? (
          <button type="button" onClick={() => onDialog({ kind: 'evidence', item })}>
            {t('aud.remediation.evidence.action')}
          </button>
        ) : null}
        {canVerify(item, caller) ? (
          <button type="button" className="primary" onClick={() => onDialog({ kind: 'verify', item })}>
            {t('aud.remediation.verify.action')}
          </button>
        ) : null}
        {canDecide(item, caller) ? (
          <button type="button" onClick={() => onDialog({ kind: 'decide', item })}>
            {t('aud.remediation.decision.action')}
          </button>
        ) : null}
      </div>
    </article>
  );
}
