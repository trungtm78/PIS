import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { send } from './ClosureForms';
import { Field } from './components';
import { offeredLevels } from './escalation-model';
import { useAcceptEscalation, useEscalateIssue, useUnits } from './hooks';
import { Problem, tooLong } from './IssueActions';
import { useMoment } from './issue-components';
import type { EscalationLevel, IssueView } from './issue-model';

function levelLabel(t: ReturnType<typeof useTranslation>['t'], level: EscalationLevel): string {
  switch (level) {
    case 1:
      return t('iss.escalation.level1.option');
    case 2:
      return t('iss.escalation.level2.option');
    case 3:
      return t('iss.escalation.level3.option');
  }
}

/**
 * Raises the issue to a unit or to the task force by hand (escalateIssue): above the level it has reached, with the reason. A task force is offered only
 * when one answers for the issue today; the original issue stays open and keeps its deadline.
 */
export function EscalateForm({ issue, onReload, onDone }: { issue: IssueView; onReload: () => void; onDone: (notice: string) => void }) {
  const { t } = useTranslation();
  const units = useUnits();
  const escalate = useEscalateIssue();
  const levels = offeredLevels(issue.escalationLevel, issue.activeTaskForce);
  const [level, setLevel] = useState<'' | `${EscalationLevel}`>('');
  const [targetUnitId, setTargetUnitId] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const reasonProblem = reason.trim() === '' ? t('iss.field.required.error') : tooLong(reason) ? t('iss.field.tooLong.error') : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (escalate.isPending) return;
    if (level === '' || reasonProblem !== undefined) {
      setChecked(true);
      return;
    }
    const chosen = Number(level) as EscalationLevel;
    send(
      escalate,
      {
        id: issue.id,
        version: issue.version,
        level: chosen,
        reason: reason.trim(),
        ...(chosen < 3 && targetUnitId !== '' ? { targetUnitId } : {}),
        ...(chosen === 3 && issue.activeTaskForce !== null ? { taskForceId: issue.activeTaskForce.id } : {}),
      },
      () => onDone(t('iss.extension.escalate.done')),
    );
  };

  if (levels.length === 0) {
    return (
      <p className="callout" role="status" data-testid="escalate-none">
        {t('iss.extension.escalate.none.notice')}
      </p>
    );
  }

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.extension.escalate.title')}>
      <h2>{t('iss.extension.escalate.title')}</h2>
      <p className="sub">{t('iss.extension.escalate.text')}</p>
      {issue.activeTaskForce === null ? (
        <p className="sub" data-testid="no-task-force">
          {t('iss.extension.escalate.noTaskForce.text')}
        </p>
      ) : null}
      {escalate.isError ? <Problem error={escalate.error} onReload={onReload} reset={escalate.reset} /> : null}
      <Field id="escalate-level" label={t('iss.extension.escalate.level.label')} error={checked && level === '' ? t('iss.field.required.error') : undefined}>
        <select id="escalate-level" value={level} onChange={(event) => setLevel(event.target.value as '' | `${EscalationLevel}`)}>
          <option value="">{t('iss.create.choose.option')}</option>
          {levels.map((candidate) => (
            <option key={candidate} value={String(candidate)}>
              {levelLabel(t, candidate)}
            </option>
          ))}
        </select>
      </Field>
      {level === '3' && issue.activeTaskForce !== null ? (
        <p data-testid="task-force">
          {t('iss.extension.escalate.taskForce.text', { code: issue.activeTaskForce.code, name: issue.activeTaskForce.name })}
        </p>
      ) : null}
      {level === '1' || level === '2' ? (
        <Field id="escalate-unit" label={t('iss.extension.escalate.unit.label')} hint={t('iss.extension.escalate.unit.hint')} error={undefined}>
          <select id="escalate-unit" value={targetUnitId} onChange={(event) => setTargetUnitId(event.target.value)}>
            <option value="">{t('iss.extension.escalate.ownerUnit.option', { name: issue.ownerUnitName })}</option>
            {(units.data ?? [])
              .filter((unit) => unit.id !== issue.ownerUnitId)
              .map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.code} · {unit.name}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <Field id="escalate-reason" label={t('iss.extension.escalate.reason.label')} error={checked ? reasonProblem : undefined}>
        <textarea id="escalate-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={escalate.isPending}>
          {escalate.isPending ? t('iss.extension.escalate.pending') : t('iss.extension.escalate.action')}
        </button>
      </div>
    </form>
  );
}

/** The receiver accepts an escalation (acceptIssueEscalation) with an optional note; used on a line of the board. */
export function AcceptForm({ escalationId, onDone }: { escalationId: string; onDone: (notice: string) => void }) {
  const { t } = useTranslation();
  const accept = useAcceptEscalation();
  const [note, setNote] = useState('');
  const [tooLongNote, setTooLongNote] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (accept.isPending) return;
    if (tooLong(note)) {
      setTooLongNote(true);
      return;
    }
    setTooLongNote(false);
    send(accept, { id: escalationId, ...(note.trim() === '' ? {} : { note: note.trim() }) }, () => onDone(t('iss.board.accept.done')));
  };

  return (
    <form className="iss-accept" onSubmit={submit} noValidate aria-label={t('iss.board.accept.title')}>
      {accept.isError ? <Problem error={accept.error} onReload={() => undefined} reset={accept.reset} /> : null}
      <Field id={`accept-note-${escalationId}`} label={t('iss.board.accept.note.label')} error={tooLongNote ? t('iss.field.tooLong.error') : undefined}>
        <input id={`accept-note-${escalationId}`} type="text" value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <button type="submit" className="button primary" disabled={accept.isPending}>
        {accept.isPending ? t('iss.board.accept.pending') : t('iss.board.accept.action')}
      </button>
    </form>
  );
}

/** The list of escalations of one issue, newest first: the level, who it went to, whether it was accepted and when it was due. */
export function EscalationList({ issue }: { issue: IssueView }) {
  const { t } = useTranslation();
  const moment = useMoment();
  if (issue.escalations.length === 0) {
    return (
      <p className="muted" data-testid="no-escalations">
        {t('iss.extension.escalations.none.text')}
      </p>
    );
  }
  return (
    <ol data-testid="escalations">
      {issue.escalations.map((escalation) => (
        <li key={escalation.id} data-level={escalation.level}>
          <p>
            <strong>{levelLabel(t, escalation.level)}</strong> ·{' '}
            {escalation.taskForce !== null ? `${escalation.taskForce.code} · ${escalation.taskForce.name}` : (escalation.targetUnit?.name ?? t('iss.value.none.text'))}
          </p>
          <p className="sub">
            {escalation.status === 'ACCEPTED'
              ? t('iss.extension.escalations.accepted.text', { date: moment(escalation.acceptedAt) })
              : t('iss.extension.escalations.due.text', { date: moment(escalation.acceptDueAt) })}{' '}
            · {escalation.trigger === 'SLA_AUTO' ? t('iss.extension.escalations.auto.text') : t('iss.extension.escalations.manual.text')}
          </p>
          {escalation.reason === null || escalation.trigger === 'SLA_AUTO' ? null : <p className="iss-note">{escalation.reason}</p>}
        </li>
      ))}
    </ol>
  );
}
