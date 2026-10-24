import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useAssignIssue, useAssignees, useCommentIssue, useStartIssue, useTransferIssue, useUnits } from './hooks';
import { issueProblemMessage } from './issue-labels';
import { TEXT_MAX_LENGTH, describeProblem } from './issue-model';
import type { IssueView } from './issue-model';

/** What a form of the workspace needs from it: the issue, and how to read it again after a conflict. */
interface ActionProps {
  issue: IssueView;
  onReload: () => void;
}

function Problem({ error, onReload, reset }: { error: unknown; onReload: () => void; reset: () => void }) {
  const { t } = useTranslation();
  const problem = describeProblem(error);
  return (
    <>
      <p className="callout warning" role="alert" data-testid="problem">
        {issueProblemMessage(t, problem)}
      </p>
      {problem.reason === 'versionConflict' ? (
        <p>
          <button
            type="button"
            className="button"
            onClick={() => {
              reset();
              onReload();
            }}
          >
            {t('iss.workspace.reload.action')}
          </button>
        </p>
      ) : null}
    </>
  );
}

const tooLong = (value: string): boolean => value.length > TEXT_MAX_LENGTH;

/** Gives the issue to a member of the tenant (assignIssue); the server refuses a person who cannot work it where it lies. */
export function AssignForm({ issue, onReload }: ActionProps) {
  const { t } = useTranslation();
  const members = useAssignees(issue.id);
  const assign = useAssignIssue();
  const [assigneeId, setAssigneeId] = useState('');
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (assign.isPending) return;
    if (assigneeId === '' || tooLong(note)) {
      setMissing(true);
      return;
    }
    setMissing(false);
    assign.mutate(
      { id: issue.id, version: issue.version, assigneeId, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      {
        onSuccess: () => {
          setSaved(true);
          setAssigneeId('');
          setNote('');
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.workspace.assign.title')}>
      <h2>{t('iss.workspace.assign.title')}</h2>
      {members.isError ? (
        <p className="callout warning" role="status" data-testid="members-unavailable">
          {t('iss.workspace.assign.members.error')}
        </p>
      ) : null}
      {assign.isError ? <Problem error={assign.error} onReload={onReload} reset={assign.reset} /> : null}
      {saved ? (
        <p role="status" data-testid="assigned">
          {t('iss.workspace.assign.done')}
        </p>
      ) : null}
      <Field id="assign-assignee" label={t('iss.workspace.assign.assignee.label')} error={missing && assigneeId === '' ? t('iss.field.required.error') : undefined}>
        <select
          id="assign-assignee"
          value={assigneeId}
          onChange={(event) => {
            setAssigneeId(event.target.value);
            setSaved(false);
          }}
        >
          <option value="">{t('iss.create.choose.option')}</option>
          {(members.data ?? []).map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="assign-note" label={t('iss.workspace.assign.note.label')} error={missing && tooLong(note) ? t('iss.field.tooLong.error') : undefined}>
        <textarea id="assign-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={assign.isPending}>
          {assign.isPending ? t('iss.workspace.assign.pending') : t('iss.workspace.assign.action')}
        </button>
      </div>
    </form>
  );
}

/** The assignee takes the issue up (startIssue): the moment is the response of the SLA. */
export function StartForm({ issue, onReload }: ActionProps) {
  const { t } = useTranslation();
  const start = useStartIssue();
  return (
    <div className="card" aria-label={t('iss.workspace.start.title')}>
      <h2>{t('iss.workspace.start.title')}</h2>
      <p>{t('iss.workspace.start.text')}</p>
      {start.isError ? <Problem error={start.error} onReload={onReload} reset={start.reset} /> : null}
      <button type="button" className="button primary" disabled={start.isPending} onClick={() => start.mutate({ id: issue.id, version: issue.version })}>
        {start.isPending ? t('iss.workspace.start.pending') : t('iss.workspace.start.action')}
      </button>
    </div>
  );
}

/** Adds an opinion to the timeline (commentIssue); it does not change the issue, so it never conflicts with another person's change. */
export function CommentForm({ issue, onReload }: ActionProps) {
  const { t } = useTranslation();
  const comment = useCommentIssue();
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (comment.isPending) return;
    if (note.trim() === '' || tooLong(note)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    comment.mutate(
      { id: issue.id, note: note.trim() },
      {
        onSuccess: () => {
          setSaved(true);
          setNote('');
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.workspace.comment.title')}>
      <h2>{t('iss.workspace.comment.title')}</h2>
      {comment.isError ? <Problem error={comment.error} onReload={onReload} reset={comment.reset} /> : null}
      {saved ? (
        <p role="status" data-testid="commented">
          {t('iss.workspace.comment.done')}
        </p>
      ) : null}
      <Field id="comment-note" label={t('iss.workspace.comment.note.label')} error={invalid ? (note.trim() === '' ? t('iss.field.required.error') : t('iss.field.tooLong.error')) : undefined}>
        <textarea
          id="comment-note"
          rows={3}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            setSaved(false);
          }}
        />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={comment.isPending}>
          {comment.isPending ? t('iss.workspace.comment.pending') : t('iss.workspace.comment.action')}
        </button>
      </div>
    </form>
  );
}

/** Moves the responsibility to another unit (transferIssueUnit): the deadline and the days overdue stay with the issue. */
export function TransferForm({ issue, onReload }: ActionProps) {
  const { t } = useTranslation();
  const units = useUnits();
  const transfer = useTransferIssue();
  const [targetUnitId, setTargetUnitId] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (transfer.isPending) return;
    if (targetUnitId === '' || reason.trim() === '' || tooLong(reason)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    transfer.mutate(
      { id: issue.id, version: issue.version, targetUnitId, reason: reason.trim() },
      {
        onSuccess: () => {
          setSaved(true);
          setTargetUnitId('');
          setReason('');
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('iss.workspace.transfer.title')}>
      <h2>{t('iss.workspace.transfer.title')}</h2>
      <p className="sub">{t('iss.workspace.transfer.keep.text')}</p>
      {transfer.isError ? <Problem error={transfer.error} onReload={onReload} reset={transfer.reset} /> : null}
      {saved ? (
        <p role="status" data-testid="transferred">
          {t('iss.workspace.transfer.done')}
        </p>
      ) : null}
      <Field id="transfer-unit" label={t('iss.workspace.transfer.unit.label')} error={invalid && targetUnitId === '' ? t('iss.field.required.error') : undefined}>
        <select
          id="transfer-unit"
          value={targetUnitId}
          onChange={(event) => {
            setTargetUnitId(event.target.value);
            setSaved(false);
          }}
        >
          <option value="">{t('iss.create.choose.option')}</option>
          {(units.data ?? [])
            .filter((unit) => unit.id !== issue.ownerUnitId)
            .map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.code} · {unit.name}
              </option>
            ))}
        </select>
      </Field>
      <Field id="transfer-reason" label={t('iss.workspace.transfer.reason.label')} error={invalid && (reason.trim() === '' || tooLong(reason)) ? (reason.trim() === '' ? t('iss.field.required.error') : t('iss.field.tooLong.error')) : undefined}>
        <textarea id="transfer-reason" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={transfer.isPending}>
          {transfer.isPending ? t('iss.workspace.transfer.pending') : t('iss.workspace.transfer.action')}
        </button>
      </div>
    </form>
  );
}
