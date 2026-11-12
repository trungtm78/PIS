import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { blockerWord } from '../labels';
import type { TaskDetail } from '../model';
import { blockerRows } from './model';
import type { Actions } from './model';
import type { TaskDialog } from './TaskDialogs';

export interface ActionsBarProps {
  task: TaskDetail;
  actions: Actions;
  onOpen: (dialog: TaskDialog) => void;
  /** Starts a waiver of one requirement the completion check says a waiver could cover. */
  onWaive: (subject: string) => void;
}

/** What may be done with the task now (the buttons come from the `can_*` flags of the server) and, while it is in progress, what still stops its completion. */
export function ActionsBar({ task, actions, onOpen, onWaive }: ActionsBarProps) {
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
  return (
    <SectionCard title={t('pwf.task.actions.title')}>
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
                    {blockerWord(t, row.code, row.subject)}
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
      {shown.length === 0 ? (
        <p className="callout" role="status" data-testid="no-actions">
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
    </SectionCard>
  );
}
