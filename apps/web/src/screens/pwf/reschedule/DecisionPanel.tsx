import { useId, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { formProblemText } from '../labels';
import { MAX_REASON, MIN_REASON } from '../model';
import { decisionProblem } from './model';
import type { DecisionBody, HeldProposal } from './model';

export interface DecisionPanelProps {
  held: HeldProposal;
  pending: boolean;
  onDecide: (decision: DecisionBody['decision'], note: string) => void;
}

/** The decision on a proposal by a second person (maker and checker are different people): approving publishes a new schedule version, rejecting keeps the schedule and says why in at least 20 characters. */
export function DecisionPanel({ held, pending, onDecide }: DecisionPanelProps) {
  const { t } = useTranslation();
  const noteId = useId();
  const errorId = `${noteId}-error`;
  const [note, setNote] = useState('');
  const [tried, setTried] = useState<DecisionBody['decision'] | undefined>(undefined);
  const problem = tried === undefined ? undefined : decisionProblem(tried, note);
  const send = (decision: DecisionBody['decision']): void => {
    setTried(decision);
    if (decisionProblem(decision, note) !== undefined) return;
    onDecide(decision, note);
  };
  return (
    <SectionCard title={t('pwf.resched.decision.title')}>
      <div data-testid="decision-panel">
        <p>
          <StatusPill tone="info" icon="●">
            {held.preview === undefined ? t('pwf.resched.decision.open.word') : t('pwf.resched.decision.proposed.word')}
          </StatusPill>
        </p>
        <p className="pwf-hint" data-testid="maker-checker">
          {t('pwf.resched.decision.makerChecker.note')}
        </p>
        {held.preview === undefined ? (
          <p className="callout warning" role="status" data-testid="no-detail">
            {t('pwf.resched.decision.noDetail.notice')}
          </p>
        ) : null}
        <div className="pwf-field pwf-field--wide">
          <label htmlFor={noteId}>{t('pwf.resched.decision.note.label')}</label>
          <textarea id={noteId} rows={3} data-testid="decision-note" value={note} aria-invalid={problem === undefined ? undefined : true} aria-describedby={problem === undefined ? undefined : errorId} onChange={(event) => setNote(event.target.value)} />
          <span className="pwf-hint">{t('pwf.resched.decision.note.hint', { min: MIN_REASON })}</span>
          {problem === undefined ? null : (
            <span id={errorId} className="pwf-field__error" data-testid="error-note">
              {formProblemText(t, problem, { min: MIN_REASON, max: MAX_REASON })}
            </span>
          )}
        </div>
        <div className="pwf-actions">
          <button type="button" className="ui-button ui-button--primary" data-testid="approve" disabled={pending} onClick={() => send('APPROVE')}>
            {t('pwf.resched.decision.approve.action')}
          </button>
          <button type="button" className="ui-button ui-button--outline" data-testid="reject" disabled={pending} onClick={() => send('REJECT')}>
            {t('pwf.resched.decision.reject.action')}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}
