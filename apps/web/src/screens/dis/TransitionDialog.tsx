import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { NavigationDialog } from '../../shell/NavigationDialog';
import { Field } from './components';
import { usePeriodMove } from './hooks';
import { fieldProblemMessage, problemMessage, statusLabel } from './labels';
import { describeProblem, validateReason, vietnamMoment } from './model';
import type { FieldProblem, PeriodMove, PeriodView } from './model';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';

export interface TransitionDialogProps {
  period: PeriodView;
  move: PeriodMove;
  onClose(): void;
}

/**
 * The confirmation of a soft close or a lock: it says what the move does, asks for the reason that the audit trail keeps, and sends the move
 * against the version of the period the list showed (If-Match), so a period that someone else changed meanwhile is refused, not overwritten.
 */
export function TransitionDialog({ period, move, onClose }: TransitionDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const send = usePeriodMove();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<FieldProblem | undefined>(undefined);
  const refused = send.isError ? describeProblem(send.error) : undefined;
  const closing = move === 'softClose';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (send.isPending) return;
    const found = validateReason(reason);
    setProblem(found);
    if (found !== undefined) return;
    send.mutate({ move, id: period.id, version: period.version, reason: reason.trim() }, { onSuccess: onClose });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{closing ? t('dis.calendar.softClose.dialog.title', { code: period.code }) : t('dis.calendar.lock.dialog.title', { code: period.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('dis.calendar.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="dis-dialog-body" onSubmit={submit} noValidate>
          <p>{closing ? t('dis.calendar.softClose.dialog.body') : t('dis.calendar.lock.dialog.body')}</p>
          <dl className="ui-dialog__context">
            <div className="ui-dialog__row">
              <dt>{t('dis.calendar.period.column')}</dt>
              <dd>{period.code}</dd>
            </div>
            <div className="ui-dialog__row">
              <dt>{t('dis.calendar.status.column')}</dt>
              <dd>{statusLabel(t, period.status)}</dd>
            </div>
            <div className="ui-dialog__row">
              <dt>{t('dis.calendar.deadline.column')}</dt>
              <dd>{vietnamMoment(period.deadlineAt)}</dd>
            </div>
          </dl>
          {refused === undefined ? null : (
            <p className="dis-w2-banner" role="alert">
              {problemMessage(t, refused)}
            </p>
          )}
          <Field id="transition-reason" label={t('dis.calendar.dialog.reason.label')} error={problem === undefined ? undefined : fieldProblemMessage(t, problem)} hint={t('dis.calendar.dialog.reason.help')}>
            <textarea
              id="transition-reason"
              rows={3}
              value={reason}
              aria-invalid={problem !== undefined}
              onChange={(event) => {
                setReason(event.target.value);
                setProblem(undefined);
              }}
            />
          </Field>
          <div className="formfooter">
            <button type="button" className="ui-button ui-button--outline" onClick={onClose}>
              {t('dis.calendar.dialog.cancel.action')}
            </button>
            <button type="submit" className="ui-button ui-button--primary" disabled={send.isPending}>
              {closing ? t('dis.calendar.softClose.confirm.action') : t('dis.calendar.lock.confirm.action')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
