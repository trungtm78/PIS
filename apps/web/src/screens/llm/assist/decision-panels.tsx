import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog, DataTable, SectionCard, StatusPill } from '../../../ui';
import { Facts } from './assist-components';
import { useDecideRun, usePermit, useReload } from './assist-hooks';
import { decisionLabel, decisionProblemText, decisionTone, errorText, scoreStatusLabel, scoreStatusTone } from './assist-labels';
import { ASSIST_DECIDE, DECISIONS, MIN_RATIONALE, bpPercent, dropItems, failureCode, initialScores, isUnsupported, scoreSheet, shortId, stamp, statementDecision } from './assist-model';
import type { AssistRun, CriterionProposal, Decision, DecisionBody, EvaluationView, StatementDecisionProblem } from './assist-model';

export interface DecisionSectionProps {
  run: AssistRun;
  /** Called with the sentence of the receipt when a decision was recorded. */
  onDone: (receipt: string) => void;
}

/**
 * What a person can do about a run: read the decision on record, or (with the right to decide, on a run that was answered, once) accept it, accept it with changes or reject it. A run of a contract evaluation is decided
 * with scores; every other run with the statements the person keeps.
 */
export function DecisionSection({ run, onDone }: DecisionSectionProps) {
  const { t } = useTranslation();
  const permit = usePermit();
  if (run.decision !== null) return <DecisionSummary run={run} />;
  if (run.status !== 'COMPLETED') return null;
  if (!permit.has(ASSIST_DECIDE)) {
    return (
      <p className="callout" data-testid="decide-no-right">
        {t('llm.assist.decide.noRight')}
      </p>
    );
  }
  if (!permit.can(ASSIST_DECIDE)) {
    return (
      <p className="callout" data-testid="decide-read-only">
        {t('llm.assist.decide.readOnly')}
      </p>
    );
  }
  return run.kind === 'CONTRACT_EVAL' && run.evaluation !== undefined ? <ScoreDecisionPanel run={run} evaluation={run.evaluation} onDone={onDone} /> : <StatementDecisionPanel run={run} onDone={onDone} />;
}

interface PanelProps {
  run: AssistRun;
  onDone: (receipt: string) => void;
}

/** What the dialog of a decision says and does about the answer of the server: the sentence of the refusal, and for a decision made by someone else a way to read the run again. */
function useDecisionDialog(run: AssistRun, onDone: PanelProps['onDone']) {
  const { t } = useTranslation();
  const decide = useDecideRun();
  const reload = useReload();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const sending = useRef(false);
  const clear = (): void => {
    setFailure(undefined);
    setMessage(undefined);
  };
  const send = (body: DecisionBody, decision: Decision, close: () => void): void => {
    if (sending.current) return;
    sending.current = true;
    clear();
    decide.mutate(
      { runId: run.id, body },
      {
        onSuccess: () => {
          sending.current = false;
          close();
          onDone(t('llm.assist.decide.receipt', { decision: decisionLabel(t, decision), time: stamp(new Date().toISOString()) }));
        },
        onError: (error) => {
          sending.current = false;
          setFailure(error);
        },
      },
    );
  };
  const staleNote = failureCode(failure) === 'AI_ASSIST_ALREADY_DECIDED';
  return {
    pending: decide.isPending,
    error: message ?? (failure === undefined ? undefined : errorText(t, failure)),
    stale: staleNote,
    setMessage,
    clear,
    send,
    reload,
  };
}

// ---- a run of statements --------------------------------------------------------------------------------------------------------------------------------------------------------

function StatementDecisionPanel({ run, onDone }: PanelProps) {
  const { t } = useTranslation();
  const supported = run.statements.filter((statement) => !isUnsupported(statement));
  const [choice, setChoice] = useState<Decision>('ACCEPTED');
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set(supported.map((statement) => statement.id)));
  const [problem, setProblem] = useState<StatementDecisionProblem | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const dialog = useDecisionDialog(run, onDone);
  const toggle = (id: string): void => {
    setKept((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setProblem(undefined);
  };
  const prepare = (): void => {
    if (choice === 'ACCEPTED_WITH_CHANGE' && dropItems(run.statements, kept).length === 0) {
      setProblem('NOTHING_DROPPED');
      return;
    }
    setProblem(undefined);
    dialog.clear();
    setOpen(true);
  };
  const confirm = (rationale: string | undefined): void => {
    const built = statementDecision(choice, run.statements, kept, rationale ?? '');
    if (built.body === undefined) {
      dialog.setMessage(decisionProblemText(t, built.problem ?? 'RATIONALE_SHORT'));
      return;
    }
    dialog.send(built.body, choice, () => setOpen(false));
  };
  return (
    <SectionCard title={t('llm.assist.decide.title')}>
      <div data-testid="decision-panel">
        <p className="sub">{t('llm.assist.decide.intro')}</p>
        <fieldset className="assist-choices">
          <legend>{t('llm.assist.decide.choice')}</legend>
          {DECISIONS.map((decision) => (
            <label key={decision} className="assist-choice">
              <input type="radio" name={`decision-${run.id}`} value={decision} checked={choice === decision} onChange={() => { setChoice(decision); setProblem(undefined); }} />
              <span>{decisionLabel(t, decision)}</span>
            </label>
          ))}
        </fieldset>
        {choice === 'ACCEPTED_WITH_CHANGE' ? (
          <fieldset className="assist-keep">
            <legend>{t('llm.assist.decide.keepTitle')}</legend>
            <ul>
              {run.statements.map((statement) => {
                const blocked = isUnsupported(statement);
                return (
                  <li key={statement.id} data-statement-id={statement.id}>
                    <label>
                      <input type="checkbox" checked={!blocked && kept.has(statement.id)} disabled={blocked} onChange={() => toggle(statement.id)} />
                      <span>
                        <code>{statement.id}</code> {statement.text}
                      </span>
                    </label>
                    {blocked ? <span className="sub"> {t('llm.assist.decide.cannotKeep')}</span> : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ) : null}
        {choice === 'ACCEPTED' && supported.length < run.statements.length ? <p className="sub">{t('llm.assist.decide.unsupportedNote')}</p> : null}
        {choice === 'REJECTED' ? <p className="sub">{t('llm.assist.decide.rejectNote')}</p> : null}
        {problem === undefined ? null : (
          <p className="field-error" role="alert" data-testid="decision-problem">
            {decisionProblemText(t, problem)}
          </p>
        )}
        <div className="assist-actions">
          <button type="button" className="ui-button ui-button--primary" data-testid="record-decision" onClick={prepare}>
            {t('llm.assist.decide.record')}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        title={t('llm.assist.decide.dialogTitle', { decision: decisionLabel(t, choice) })}
        context={[
          { label: t('llm.assist.decide.context.run'), value: shortId(run.id) },
          { label: t('llm.assist.decide.context.decision'), value: decisionLabel(t, choice) },
          { label: t('llm.assist.decide.context.kept'), value: String(choice === 'REJECTED' ? 0 : choice === 'ACCEPTED' ? supported.length : supported.filter((statement) => kept.has(statement.id)).length) },
        ]}
        confirmLabel={t('llm.assist.decide.confirm')}
        cancelLabel={t('llm.assist.decide.cancel')}
        pending={dialog.pending}
        reason={{ label: t('llm.assist.decide.rationale'), required: true, minLength: MIN_RATIONALE, hint: t('llm.assist.decide.rationaleHint', { count: MIN_RATIONALE }) }}
        {...(dialog.error === undefined ? {} : { error: dialog.error })}
        onCancel={() => setOpen(false)}
        onConfirm={confirm}
      >
        {dialog.stale ? (
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            onClick={() => {
              dialog.reload();
              setOpen(false);
            }}
          >
            {t('llm.assist.decide.reload')}
          </button>
        ) : null}
      </ConfirmDialog>
    </SectionCard>
  );
}

// ---- a contract evaluation ---------------------------------------------------------------------------------------------------------------------------------------------------

interface ScorePanelProps extends PanelProps {
  evaluation: EvaluationView;
}

/**
 * The scores of an evaluation, each accepted or set by the person, with the weighted total computed live from them by the formula of the server. There is no total until every criterion has a score; the proposals of the
 * assistant are only the starting values, and nothing is written to another module.
 */
export function ScoreDecisionPanel({ run, evaluation, onDone }: ScorePanelProps) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<Record<string, string>>(() => initialScores(evaluation.criteria));
  const [mode, setMode] = useState<'ACCEPT' | 'REJECT' | undefined>(undefined);
  const dialog = useDecisionDialog(run, onDone);
  const sheet = scoreSheet(evaluation.criteria, fields, evaluation.scaleMax);
  const decision: Decision = mode === 'REJECT' ? 'REJECTED' : sheet.decision;
  const confirm = (rationale: string | undefined): void => {
    const text = (rationale ?? '').trim();
    if ([...text].length < MIN_RATIONALE) {
      dialog.setMessage(decisionProblemText(t, 'RATIONALE_SHORT'));
      return;
    }
    const body = mode === 'REJECT' ? { decision: 'REJECTED' as const, rationale: text } : { decision: sheet.decision, rationale: text, ...(sheet.items.length === 0 ? {} : { items: sheet.items }) };
    dialog.send(body, decision, () => setMode(undefined));
  };
  const open = (next: 'ACCEPT' | 'REJECT'): void => {
    dialog.clear();
    setMode(next);
  };
  return (
    <SectionCard title={t('llm.evaluation.decide.title')}>
      <div data-testid="score-panel">
        <p className="callout" data-testid="nothing-written">
          {t('llm.evaluation.decide.nothingWritten')}
        </p>
        <DataTable<CriterionProposal>
          caption={t('llm.evaluation.decide.caption')}
          rows={evaluation.criteria}
          rowKey={(criterion) => criterion.code}
          rowAttrs={(criterion) => ({ 'data-criterion-code': criterion.code })}
          columns={[
            { key: 'code', header: t('llm.evaluation.column.code'), pinned: true, render: (criterion) => <code>{criterion.code}</code> },
            { key: 'label', header: t('llm.evaluation.column.label'), render: (criterion) => criterion.label },
            { key: 'weight', header: t('llm.evaluation.column.weight'), align: 'right', render: (criterion) => bpPercent(criterion.weightBp) },
            {
              key: 'proposal',
              header: t('llm.evaluation.column.proposal'),
              align: 'right',
              render: (criterion) => (criterion.proposedScore === null ? <StatusPill tone={scoreStatusTone(criterion.status)}>{scoreStatusLabel(t, criterion.status)}</StatusPill> : criterion.proposedScore),
            },
            {
              key: 'score',
              header: t('llm.evaluation.column.accepted', { max: evaluation.scaleMax }),
              align: 'right',
              render: (criterion) => {
                const invalid = sheet.invalid.includes(criterion.code);
                return (
                  <input
                    className="assist-score-input"
                    inputMode="numeric"
                    autoComplete="off"
                    value={fields[criterion.code] ?? ''}
                    aria-label={t('llm.evaluation.decide.scoreFor', { code: criterion.code })}
                    aria-invalid={invalid}
                    data-testid={`score-${criterion.code}`}
                    onChange={(event) => setFields((previous) => ({ ...previous, [criterion.code]: event.target.value }))}
                  />
                );
              },
            },
          ]}
        />
        {sheet.invalid.length > 0 ? (
          <p className="field-error" role="alert" data-testid="score-invalid">
            {t('llm.evaluation.decide.invalid', { max: evaluation.scaleMax })}
          </p>
        ) : null}
        <p className="assist-total" aria-live="polite" data-testid="live-total">
          {sheet.total === null ? t('llm.evaluation.total.none') : t('llm.evaluation.total.value', { total: sheet.total, max: evaluation.scaleMax })}
        </p>
        <p className="sub">{t('llm.evaluation.total.formula')}</p>
        <div className="assist-actions">
          <button type="button" className="ui-button ui-button--primary" disabled={sheet.state !== 'READY'} data-testid="accept-scores" onClick={() => open('ACCEPT')}>
            {t('llm.evaluation.decide.accept', { decision: decisionLabel(t, sheet.decision) })}
          </button>
          <button type="button" className="ui-button ui-button--outline" data-testid="reject-scores" onClick={() => open('REJECT')}>
            {t('llm.evaluation.decide.reject')}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={mode !== undefined}
        title={t('llm.assist.decide.dialogTitle', { decision: decisionLabel(t, decision) })}
        context={[
          { label: t('llm.assist.decide.context.run'), value: shortId(run.id) },
          { label: t('llm.assist.decide.context.decision'), value: decisionLabel(t, decision) },
          ...(mode === 'REJECT' || sheet.total === null ? [] : [{ label: t('llm.evaluation.decide.context.total'), value: sheet.total }]),
        ]}
        confirmLabel={t('llm.assist.decide.confirm')}
        cancelLabel={t('llm.assist.decide.cancel')}
        pending={dialog.pending}
        reason={{ label: t('llm.assist.decide.rationale'), required: true, minLength: MIN_RATIONALE, hint: t('llm.assist.decide.rationaleHint', { count: MIN_RATIONALE }) }}
        {...(dialog.error === undefined ? {} : { error: dialog.error })}
        onCancel={() => setMode(undefined)}
        onConfirm={confirm}
      >
        {dialog.stale ? (
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            onClick={() => {
              dialog.reload();
              setMode(undefined);
            }}
          >
            {t('llm.assist.decide.reload')}
          </button>
        ) : null}
      </ConfirmDialog>
    </SectionCard>
  );
}

// ---- the decision on record ---------------------------------------------------------------------------------------------------------------------------------------------

/** The decision a person recorded about the run: what, why, who and when, and what it came to (the statements kept, or the scores and the total the server computed). */
export function DecisionSummary({ run }: { run: AssistRun }) {
  const { t } = useTranslation();
  const decision = run.decision;
  if (decision === null) return null;
  const accepted = decision.accepted;
  const keptIds = accepted.keptStatements ?? [];
  const kept = run.statements.filter((statement) => keptIds.includes(statement.id));
  return (
    <SectionCard title={t('llm.assist.decided.title')} status={<StatusPill tone={decisionTone(decision.decision)}>{decisionLabel(t, decision.decision)}</StatusPill>}>
      <div data-testid="decision-summary" data-decision={decision.decision}>
        <Facts
          items={[
            { label: t('llm.assist.decided.rationale'), value: decision.rationale },
            { label: t('llm.assist.decided.by'), value: shortId(decision.decidedBy) },
            { label: t('llm.assist.decided.at'), value: stamp(decision.decidedAt) },
          ]}
        />
        {accepted.total !== null ? (
          <p className="assist-total" data-testid="accepted-total">
            {t('llm.evaluation.decided.total', { total: accepted.total })}
          </p>
        ) : null}
        {accepted.scores !== null && Object.keys(accepted.scores).length > 0 ? (
          <ul className="assist-scores" data-testid="accepted-scores">
            {Object.entries(accepted.scores).map(([code, score]) => (
              <li key={code}>
                <code>{code}</code> {score}
              </li>
            ))}
          </ul>
        ) : null}
        {decision.decision !== 'REJECTED' && accepted.keptStatements !== null && run.kind !== 'CONTRACT_EVAL' ? (
          <details open>
            <summary data-testid="kept-count">{t('llm.assist.decided.kept', { count: kept.length })}</summary>
            <ul>
              {kept.map((statement) => (
                <li key={statement.id}>{statement.text}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {run.kind === 'CONTRACT_EVAL' ? <p className="sub">{t('llm.evaluation.decided.nothingWritten')}</p> : null}
      </div>
    </SectionCard>
  );
}
