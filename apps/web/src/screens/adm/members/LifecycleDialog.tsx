import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { useAttemptedCommand } from '../roles/hooks';
import type { CommandExecutor } from '../roles/hooks';
import { errorMessage, isVersionConflict, offendingField } from './errors';
import { fieldProblemMessage, lifecycleAction, lifecycleTitle } from './labels';
import { useRefreshMembers } from './hooks';
import { reasonProblem } from './rules';
import type { Lifecycle, Member } from './types';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';

export interface LifecycleDialogProps {
  action: Lifecycle;
  member: Member;
  onClose(): void;
  onDone(): void;
}

interface LifecycleInput {
  action: Lifecycle;
  membershipId: string;
  version: number;
  reason: string;
}

const run: CommandExecutor<LifecycleInput> = (client, input, attempt) => {
  const request = { path: { membershipId: input.membershipId }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt };
  switch (input.action) {
    case 'suspend':
      return client.command('suspendMembership', request);
    case 'reactivate':
      return client.command('reactivateMembership', request);
    case 'end':
      return client.command('endMembership', request);
  }
};

/**
 * Suspends, reactivates or ends one membership with a reason of at least ten characters, using the version the list
 * showed (If-Match). A stale version is answered with a reload of the list, never with a blind retry.
 */
export function LifecycleDialog({ action, member, onClose, onDone }: LifecycleDialogProps) {
  const { t } = useTranslation();
  const refresh = useRefreshMembers();
  const titleId = useId();
  const [reason, setReason] = useState('');
  const [refused, setRefused] = useState(false);
  const command = useAttemptedCommand<LifecycleInput>(run, async () => {
    await refresh();
    onDone();
  });
  const problem = reasonProblem(reason);
  const stale = isVersionConflict(command.error);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (problem !== undefined) {
      setRefused(true);
      return;
    }
    void command.run({ action, membershipId: member.id, version: member.version, reason: reason.trim() });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{lifecycleTitle(t, action, member)}</strong>
          <button type="button" className="icon-button" aria-label={t('adm.members.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="members-dialog-body" onSubmit={submit} noValidate>
          <p className="sub">{t('adm.members.lifecycle.hint')}</p>
          <div className="field">
            <label htmlFor="member-reason">{t('adm.members.reason.label')}</label>
            <textarea
              id="member-reason"
              name="reason"
              value={reason}
              aria-invalid={(refused && problem !== undefined) || offendingField(command.error) === 'reason'}
              onChange={(event) => {
                setReason(event.target.value);
                command.resetAttempt();
              }}
            />
            <small>{t('adm.members.reason.help')}</small>
            {refused && problem !== undefined ? (
              <small role="alert" className="members-error">
                {fieldProblemMessage(t, problem)}
              </small>
            ) : null}
          </div>
          {command.error === undefined ? null : (
            <div className="callout warning" role="alert">
              {errorMessage(t, command.error)}
              {stale ? (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => {
                      void refresh();
                      onClose();
                    }}
                  >
                    {t('adm.members.error.reload.action')}
                  </button>
                </>
              ) : null}
            </div>
          )}
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('adm.members.dialog.cancel.action')}
            </button>
            <button type="submit" className={action === 'end' ? 'danger' : 'primary'} disabled={command.pending}>
              {lifecycleAction(t, action)}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
