import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { rescheduleLink, taskLink } from '../model';
import type { WorkflowTask } from '../model';
import { useApproveTask, useClaimTask, useCompleteTask } from '../task/hooks';
import { completeBody, decisionBody } from '../task/model';
import { ExtensionNote } from '../task-cells';
import { extensionOffer, rowActionOf } from './step-table-model';
import type { Capabilities } from './step-table-model';

interface Props {
  task: WorkflowTask;
  projectId: string;
  can: Capabilities;
  /** Told how a command ended: the refusal (the table shows it above the rows), or nothing on success. */
  onResult: (error?: unknown) => void;
}

/**
 * What a row lets a person do without leaving the table, by state and by what they hold (never more than the server allows: it decides again and says why not). One main action: take it ("Nhận việc"), go and submit the evidence
 * ("Nộp hồ sơ", the many fields are on PWF-04), complete it, or approve its completion; and, where the frozen template allows it, "Xin gia hạn" with how much of the limit is used (it opens the request of PWF-06 for this step).
 */
export function RowActions({ task, projectId, can, onResult }: Props) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<'complete' | 'approve' | null>(null);
  const claim = useClaimTask();
  const complete = useCompleteTask();
  const approve = useApproveTask();
  const action = rowActionOf(task, can);
  const offer = extensionOffer(task, can);
  const settle = {
    onSuccess: () => {
      setDialog(null);
      onResult();
    },
    onError: (error: unknown) => {
      setDialog(null);
      onResult(error);
    },
  };
  const named = (key: 'claim' | 'submit' | 'complete' | 'approve'): string => {
    switch (key) {
      case 'claim':
        return t('pwfp.row.claim.aria', { name: task.name });
      case 'submit':
        return t('pwfp.row.submit.aria', { name: task.name });
      case 'complete':
        return t('pwfp.row.complete.aria', { name: task.name });
      case 'approve':
        return t('pwfp.row.approve.aria', { name: task.name });
    }
  };
  if (action === null && offer === null) return null;
  return (
    <div className="pwfp-actions" data-testid={`actions-${task.task_code}`}>
      {action === 'claim' ? (
        <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="claim" aria-label={named('claim')} disabled={claim.isPending} onClick={() => claim.mutate({ id: task.id }, { onSuccess: () => onResult(), onError: (error) => onResult(error) })}>
          {t('pwfp.row.claim.action')}
        </button>
      ) : null}
      {action === 'submit' ? (
        <Link className="ui-button ui-button--primary ui-button--small" data-action="submit" aria-label={named('submit')} to={taskLink(task.id, projectId)}>
          {t('pwfp.row.submit.action')}
        </Link>
      ) : null}
      {action === 'complete' ? (
        <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="complete" aria-label={named('complete')} onClick={() => setDialog('complete')}>
          {t('pwf.task.complete.action')}
        </button>
      ) : null}
      {action === 'approve' ? (
        <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="approve" aria-label={named('approve')} onClick={() => setDialog('approve')}>
          {t('pwf.task.approve.action')}
        </button>
      ) : null}
      {offer === null ? null : offer.capped ? (
        <span className="pwf-hint" data-testid={`extension-capped-${task.task_code}`}>
          {t('pwfp.row.extend.capped.text')}
        </span>
      ) : (
        <Link className="ui-button ui-button--outline ui-button--small" data-action="extend" aria-label={t('pwfp.row.extend.aria', { name: task.name })} to={rescheduleLink(projectId, undefined, task.task_code)}>
          {t('pwfp.row.extend.action')}
        </Link>
      )}
      {offer === null ? null : <ExtensionNote task={task} />}
      {dialog === 'complete' ? (
        <ConfirmDialog
          open
          title={t('pwf.task.complete.title')}
          context={[{ label: t('pwf.task.dialog.task.label'), value: task.name }]}
          confirmLabel={t('pwf.task.complete.action')}
          cancelLabel={t('pwf.task.dialog.cancel.action')}
          pending={complete.isPending}
          reason={{ label: t('pwf.task.complete.note.label') }}
          onCancel={() => setDialog(null)}
          onConfirm={(note) => complete.mutate({ id: task.id, version: task.version, body: completeBody({ actualFinish: '', exceptionId: '', note: note ?? '' }) }, settle)}
        />
      ) : null}
      {dialog === 'approve' ? (
        <ConfirmDialog
          open
          title={t('pwf.task.approve.title')}
          context={[{ label: t('pwf.task.dialog.task.label'), value: task.name }]}
          confirmLabel={t('pwf.task.approve.action')}
          cancelLabel={t('pwf.task.dialog.cancel.action')}
          pending={approve.isPending}
          reason={{ label: t('pwf.task.approve.note.label') }}
          onCancel={() => setDialog(null)}
          onConfirm={(note) => approve.mutate({ id: task.id, version: task.version, body: decisionBody('APPROVE', note) }, settle)}
        />
      ) : null}
    </div>
  );
}
