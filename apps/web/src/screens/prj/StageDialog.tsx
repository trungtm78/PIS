import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { Field } from './components';
import { stageLabel } from './labels';
import { useLifecycle, useStageMove } from './pipeline-hooks';
import { documentFieldLabel, guardLabel, guardStateLabel, moveLabel, stageFieldProblemMessage, stageProblemMessage } from './pipeline-labels';
import {
  EMPTY_STAGE_FORM,
  describeStageProblem,
  inputGuards,
  offeredMoves,
  stageBody,
  unmetGuards,
  validateStageForm,
  warningGuards,
} from './pipeline-model';
import type { BoardCard, Lifecycle, NextMove, StageForm } from './pipeline-model';
import './prj.css';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';

export interface StageDialogProps {
  card: BoardCard;
  onClose(): void;
}

/**
 * The confirmation of a move of a project (PRJ-14). It reads the lifecycle of the project, offers the moves the caller may make from the
 * stage the project is in, and names every guard of the chosen move with its state: a guard that is not met is told, and the move is not
 * sent, instead of moving the project silently or failing without a word. The move is sent against the version the lifecycle showed (If-Match).
 */
export function StageDialog({ card, onClose }: StageDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const lifecycle = useLifecycle(card.id);
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{t('prj.board.dialog.title', { code: card.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('prj.board.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="prj-dialog-body">
          {lifecycle.isLoading ? (
            <p role="status">{t('prj.board.dialog.loading.notice')}</p>
          ) : lifecycle.isError || lifecycle.data === null || lifecycle.data === undefined ? (
            <p className="callout warning" role="alert">
              {t('prj.board.dialog.error.notice')}
            </p>
          ) : (
            <Moves lifecycle={lifecycle.data} onClose={onClose} />
          )}
        </div>
      </section>
    </NavigationDialog>
  );
}

function Moves({ lifecycle, onClose }: { lifecycle: Lifecycle; onClose(): void }) {
  const { t } = useTranslation();
  const moves = offeredMoves(lifecycle);
  const [chosen, setChosen] = useState<NextMove | undefined>(moves[0]);
  const [form, setForm] = useState<StageForm>(EMPTY_STAGE_FORM);
  const [submitted, setSubmitted] = useState(false);
  const send = useStageMove();
  const refused = send.isError ? describeStageProblem(send.error) : undefined;
  const problems = chosen === undefined ? {} : validateStageForm(chosen, form);
  const unmet = chosen === undefined ? [] : unmetGuards(chosen);
  const warnings = chosen === undefined ? [] : warningGuards(chosen);
  const inputs = chosen === undefined ? [] : inputGuards(chosen);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (chosen === undefined || send.isPending || unmet.length > 0 || Object.keys(problems).length > 0) return;
    send.mutate({ operation: chosen.operation, id: lifecycle.projectId, version: lifecycle.version, body: stageBody(chosen, form) }, { onSuccess: onClose });
  };

  const choose = (move: NextMove): void => {
    setChosen(move);
    setSubmitted(false);
  };
  const error = (field: keyof StageForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? stageFieldProblemMessage(t, problem) : undefined;
  };

  return (
    <form onSubmit={submit} noValidate>
      <p data-testid="current-stage">{t('prj.board.dialog.current.text', { stage: stageLabel(t, lifecycle.status) })}</p>
      {moves.length === 0 || chosen === undefined ? (
        <p className="callout" role="status" data-testid="no-moves">
          {t('prj.board.dialog.noMoves.notice')}
        </p>
      ) : (
        <>
          <fieldset className="prj-moves">
            <legend>{t('prj.board.dialog.choose.label')}</legend>
            {moves.map((move) => (
              <label key={move.operation} className="check">
                <input type="radio" name="move" checked={chosen.operation === move.operation} onChange={() => choose(move)} />
                {t('prj.board.dialog.option.text', { move: moveLabel(t, move.operation), stage: stageLabel(t, move.to) })}
              </label>
            ))}
          </fieldset>
          <h3>{t('prj.board.dialog.guards.title')}</h3>
          {chosen.guards.length === 0 ? (
            <p className="sub">{t('prj.board.dialog.noGuards.notice')}</p>
          ) : (
            <ul className="prj-guards" data-testid="guards">
              {chosen.guards.map((guard) => (
                <li key={guard.key} data-guard={guard.key} data-state={guard.state}>
                  {guardLabel(t, guard.key)}: <strong>{guardStateLabel(t, guard.state)}</strong>
                </li>
              ))}
            </ul>
          )}
          {unmet.length === 0 ? null : (
            <p className="callout warning" role="alert" data-testid="unmet">
              {t('prj.board.dialog.unmet.notice', { guards: unmet.map((guard) => guardLabel(t, guard.key)).join(', ') })}
            </p>
          )}
          {warnings.length === 0 ? null : (
            <p className="callout" role="status" data-testid="warned">
              {t('prj.board.dialog.warned.notice', { guards: warnings.map((guard) => guardLabel(t, guard.key)).join(', ') })}
            </p>
          )}
          {refused === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {stageProblemMessage(t, refused)}
            </p>
          )}
          <div className="formgrid">
            <Field id="stage-reason" label={t('prj.board.dialog.reason.label')} error={error('reason')} hint={t('prj.board.dialog.reason.help')}>
              <textarea id="stage-reason" rows={3} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
            </Field>
            {inputs.map((guard) => (
              <Field key={guard.key} id="stage-document" label={documentFieldLabel(t, guard.key)} error={error('documentId')} hint={t('prj.board.dialog.document.help')}>
                <input id="stage-document" value={form.documentId} aria-invalid={error('documentId') !== undefined} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
              </Field>
            ))}
            <Field id="stage-date" label={t('prj.board.dialog.date.label')} error={error('effectiveDate')}>
              <input id="stage-date" type="date" value={form.effectiveDate} aria-invalid={error('effectiveDate') !== undefined} onChange={(event) => setForm({ ...form, effectiveDate: event.target.value })} />
            </Field>
          </div>
        </>
      )}
      <HistoryList lifecycle={lifecycle} />
      <div className="formfooter">
        <button type="button" onClick={onClose}>
          {t('prj.board.dialog.cancel.action')}
        </button>
        <button type="submit" className="primary" disabled={chosen === undefined || unmet.length > 0 || send.isPending}>
          {t('prj.board.dialog.confirm.action')}
        </button>
      </div>
    </form>
  );
}

function HistoryList({ lifecycle }: { lifecycle: Lifecycle }) {
  const { t } = useTranslation();
  return (
    <>
      <h3>{t('prj.board.dialog.history.title')}</h3>
      {lifecycle.history.length === 0 ? (
        <p className="sub" data-testid="no-history">
          {t('prj.board.dialog.history.empty')}
        </p>
      ) : (
        <ol className="prj-history" data-testid="history">
          {lifecycle.history.map((line, index) => (
            <li key={`${line.occurredAt}-${index}`}>
              {t('prj.board.dialog.history.entry', {
                from: stageLabel(t, line.from),
                to: stageLabel(t, line.to),
                actor: line.actorKind === 'SYSTEM' ? t('prj.board.dialog.history.system') : (line.actorName ?? t('prj.board.dialog.history.unknown')),
                date: line.occurredAt.slice(0, 10),
              })}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
