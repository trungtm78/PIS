import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { docTypeName } from '../codes';
import { blockerWord } from '../labels';
import { rescheduleLink } from '../model';
import type { TaskDetail } from '../model';
import { ExtensionNote } from '../task-cells';
import { extensionOffer } from '../workflow/step-table-model';
import { blockerRows } from './model';
import type { Actions, BlockerRow } from './model';
import type { TaskDialog } from './TaskDialogs';

export interface ActionsBarProps {
  task: TaskDetail;
  actions: Actions;
  onOpen: (dialog: TaskDialog) => void;
  /** Starts a waiver of one requirement the completion check says a waiver could cover. */
  onWaive: (subject: string) => void;
  /** Takes the task for the person ("Nhận việc"); the screen says how it ended. */
  onClaim: () => void;
  claiming: boolean;
  /** The project the task belongs to (the address says it), for the request of an extension; none, no request. */
  projectId: string | null;
  /** Whether the person may propose a change of the schedule (`pwf.schedule.propose`). */
  canPropose: boolean;
}

/** What may be done with the task now (the buttons come from the `can_*` flags of the server) and, while it is in progress, what still stops its completion. */
export function ActionsBar({ task, actions, onOpen, onWaive, onClaim, claiming, projectId, canPropose }: ActionsBarProps) {
  const { t } = useTranslation();
  const rows = blockerRows(task.completion);
  const buttons: Array<[boolean, 'start' | 'complete' | 'approve' | 'return' | 'resume', string]> = [
    [actions.start, 'start', t('pwf.task.start.action')],
    [actions.complete, 'complete', t('pwf.task.complete.action')],
    [actions.approve, 'approve', t('pwf.task.approve.action')],
    [actions.return, 'return', t('pwf.task.return.action')],
    [actions.resume, 'resume', t('pwf.task.resume.action')],
  ];
  const shown = buttons.filter(([allowed]) => allowed);
  const offer = projectId === null ? null : extensionOffer(task, { work: actions.work, approve: actions.approve, propose: canPropose });
  // What a blocker is about, by its name: the item of the checklist, the legal document type or the form; the code stays the fallback.
  const subjectName = (row: BlockerRow): string => {
    if (row.code === 'LEGAL_DOC_MISSING') return task.legal_doc_types.find((one) => one.code === row.subject)?.name ?? docTypeName(t, row.subject);
    if (row.code === 'FORM_MISSING') return task.form_templates.find((form) => form.code === row.subject)?.current_title ?? row.subject;
    if (row.code === 'CHECKLIST_ITEM_OPEN' || row.code === 'EVIDENCE_MISSING') return task.checklist.find((item) => item.item_code === row.subject)?.name ?? row.subject;
    return row.subject;
  };
  return (
    <section className="pwft-bar" aria-label={t('pwf.task.actions.title')} data-testid="task-actions">
      {task.status === 'IN_PROGRESS' ? (
        <div data-testid="completion-check">
          {task.completion.ok ? (
            <StatusPill tone="success" icon="✓">
              {t('pwf.task.completion.ok')}
            </StatusPill>
          ) : (
            <>
              <StatusPill tone="warning" icon="⚠">
                {t('pwf.task.completion.blocked')}
              </StatusPill>
              <ul className="pwf-list" data-testid="completion-blockers">
                {rows.map((row) => (
                  <li key={`${row.code}:${row.subject}`}>
                    {blockerWord(t, row.code, subjectName(row))}
                    {row.coverable ? <span className="pwf-hint"> {t('pwf.task.completion.coverable')}</span> : null}
                    {row.coverable && actions.requestException ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`waive-${row.subject}`} onClick={() => onWaive(row.subject)}>
                        {t('pwf.task.completion.waive.action')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
      {actions.claim ? (
        <div className="pwf-actions">
          <button type="button" className="ui-button ui-button--primary" data-action="claim" disabled={claiming} onClick={onClaim}>
            {t('pwfp.row.claim.action')}
          </button>
          <span className="pwf-hint">{t('pwft.bar.claim.hint')}</span>
        </div>
      ) : null}
      {offer === null || projectId === null ? null : (
        <div className="pwf-actions" data-testid="extension-offer">
          {offer.capped ? (
            <span className="pwf-hint">{t('pwfp.row.extend.capped.text')}</span>
          ) : (
            <Link className="ui-button ui-button--outline" data-action="extend" to={rescheduleLink(projectId, undefined, task.task_code)}>
              {t('pwfp.row.extend.action')}
            </Link>
          )}
          <ExtensionNote task={task} />
        </div>
      )}
      {shown.length === 0 && !actions.claim && offer === null ? (
        <p className="pwf-hint" role="status" data-testid="no-actions">
          {t('pwf.task.actions.none')}
        </p>
      ) : (
        <div className="pwf-actions">
          {shown.map(([, kind, label]) => (
            <button key={kind} type="button" className={kind === 'complete' || kind === 'approve' || kind === 'start' ? 'ui-button ui-button--primary' : 'ui-button ui-button--outline'} data-action={kind} onClick={() => onOpen({ kind })}>
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
