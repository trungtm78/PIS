import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { MIN_REASON, dayText } from '../model';
import type { TaskDetail } from '../model';
import { Field } from './Field';
import { useApproveTask, useCompleteChecklistItem, useCompleteTask, useDecideException, useResumeTask, useReturnTask, useStartTask } from './hooks';
import { approvedWaivers, completeBody, decisionBody, returnBody, startBody } from './model';
import type { TaskException } from './model';

export type TaskDialog =
  | { kind: 'start' }
  | { kind: 'complete' }
  | { kind: 'approve' }
  | { kind: 'return' }
  | { kind: 'resume' }
  | { kind: 'tick'; itemCode: string; itemName: string }
  | { kind: 'decide'; exception: TaskException; decision: 'APPROVE' | 'REJECT' };

export interface TaskDialogsProps {
  task: TaskDetail;
  dialog: TaskDialog | null;
  onClose: () => void;
  /** Told how the command ended: the refusal, or nothing on success. The dialog closes either way; the screen shows the refusal. */
  onResult: (error?: unknown) => void;
}

/** The dialogs of the commands of a task. Each names the task, asks for the reason or note the command takes and sends the command with the version the person saw. */
export function TaskDialogs({ task, dialog, onClose, onResult }: TaskDialogsProps) {
  const { t } = useTranslation();
  const start = useStartTask();
  const complete = useCompleteTask();
  const approve = useApproveTask();
  const returned = useReturnTask();
  const resume = useResumeTask();
  const tick = useCompleteChecklistItem();
  const decide = useDecideException();
  if (dialog === null) return null;
  const settle = {
    onSuccess: () => {
      onClose();
      onResult();
    },
    onError: (error: unknown) => {
      onClose();
      onResult(error);
    },
  };
  const context = [{ label: t('pwf.task.dialog.task.label'), value: task.name }];
  const cancelLabel = t('pwf.task.dialog.cancel.action');
  const id = task.id;
  const version = task.version;
  switch (dialog.kind) {
    case 'start':
      return (
        <ConfirmDialog
          open
          title={t('pwf.task.start.title')}
          context={context}
          confirmLabel={t('pwf.task.start.action')}
          cancelLabel={cancelLabel}
          pending={start.isPending}
          reason={{ label: t('pwf.task.start.reason.label'), hint: t('pwf.task.start.reason.hint') }}
          onCancel={onClose}
          onConfirm={(reason) => start.mutate({ id, version, body: startBody(reason) }, settle)}
        />
      );
    case 'complete':
      return <CompleteDialog task={task} pending={complete.isPending} onCancel={onClose} onConfirm={(form) => complete.mutate({ id, version, body: completeBody(form) }, settle)} />;
    case 'approve':
      return (
        <ConfirmDialog
          open
          title={t('pwf.task.approve.title')}
          context={context}
          confirmLabel={t('pwf.task.approve.action')}
          cancelLabel={cancelLabel}
          pending={approve.isPending}
          reason={{ label: t('pwf.task.approve.note.label') }}
          onCancel={onClose}
          onConfirm={(note) => approve.mutate({ id, version, body: decisionBody('APPROVE', note) }, settle)}
        />
      );
    case 'return':
      return (
        <ConfirmDialog
          open
          title={t('pwf.task.return.title')}
          context={context}
          confirmLabel={t('pwf.task.return.action')}
          cancelLabel={cancelLabel}
          pending={returned.isPending}
          reason={{ label: t('pwf.task.return.reason.label'), required: true, minLength: MIN_REASON, hint: t('pwf.task.reason.hint', { min: MIN_REASON }) }}
          onCancel={onClose}
          onConfirm={(reason) => returned.mutate({ id, version, body: returnBody(reason ?? '') }, settle)}
        />
      );
    case 'resume':
      return <ConfirmDialog open title={t('pwf.task.resume.title')} context={context} confirmLabel={t('pwf.task.resume.action')} cancelLabel={cancelLabel} pending={resume.isPending} onCancel={onClose} onConfirm={() => resume.mutate({ id, version }, settle)} />;
    case 'tick': {
      const { itemCode } = dialog;
      return (
        <ConfirmDialog
          open
          title={t('pwf.task.tick.title')}
          context={[...context, { label: t('pwf.task.tick.item.label'), value: `${dialog.itemCode} · ${dialog.itemName}` }]}
          confirmLabel={t('pwf.task.tick.action')}
          cancelLabel={cancelLabel}
          pending={tick.isPending}
          reason={{ label: t('pwf.task.tick.note.label') }}
          onCancel={onClose}
          onConfirm={(note) => tick.mutate({ id, version, itemCode, body: note === undefined || note === '' ? {} : { note } }, settle)}
        />
      );
    }
    case 'decide': {
      const { exception, decision } = dialog;
      return (
        <ConfirmDialog
          open
          title={decision === 'APPROVE' ? t('pwf.task.exception.approve.title') : t('pwf.task.exception.reject.title')}
          context={[...context, { label: t('pwf.task.exception.reason.label'), value: exception.reason }]}
          confirmLabel={decision === 'APPROVE' ? t('pwf.task.exception.approve.action') : t('pwf.task.exception.reject.action')}
          cancelLabel={cancelLabel}
          pending={decide.isPending}
          reason={{ label: t('pwf.task.exception.note.label') }}
          onCancel={onClose}
          onConfirm={(note) => decide.mutate({ id: exception.id, version: exception.version, body: decisionBody(decision, note) }, settle)}
        />
      );
    }
  }
}

function CompleteDialog({ task, pending, onCancel, onConfirm }: { task: TaskDetail; pending: boolean; onCancel: () => void; onConfirm: (form: { actualFinish: string; exceptionId: string; note: string }) => void }) {
  const { t } = useTranslation();
  const [finish, setFinish] = useState('');
  const [waiver, setWaiver] = useState('');
  const waivers = approvedWaivers(task);
  return (
    <ConfirmDialog
      open
      title={t('pwf.task.complete.title')}
      context={[{ label: t('pwf.task.dialog.task.label'), value: task.name }, ...(task.approver_role === null ? [] : [{ label: t('pwf.task.complete.approver.label'), value: t('pwf.task.complete.approver.text', { role: task.approver_role }) }])]}
      confirmLabel={t('pwf.task.complete.action')}
      cancelLabel={t('pwf.task.dialog.cancel.action')}
      pending={pending}
      reason={{ label: t('pwf.task.complete.note.label') }}
      onCancel={onCancel}
      onConfirm={(note) => onConfirm({ actualFinish: finish, exceptionId: waiver, note: note ?? '' })}
    >
      <Field id="complete-finish" label={t('pwf.task.complete.finish.label')} error={undefined} testKey="finish">
        <input id="complete-finish" type="date" data-testid="field-finish" value={finish} onChange={(event) => setFinish(event.target.value)} />
      </Field>
      {waivers.length === 0 ? null : (
        <Field id="complete-waiver" label={t('pwf.task.complete.waiver.label')} error={undefined} testKey="waiver">
          <select id="complete-waiver" data-testid="field-waiver" value={waiver} onChange={(event) => setWaiver(event.target.value)}>
            <option value="">{t('pwf.task.complete.waiver.none')}</option>
            {waivers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.items.join(', ')} · {item.valid_from === null ? item.reason : dayText(item.valid_from)}
              </option>
            ))}
          </select>
        </Field>
      )}
    </ConfirmDialog>
  );
}
