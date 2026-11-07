import { useTranslation } from '../../../i18n';
import { lifecycleRowLabel, lifecycleAction } from './labels';
import { lifecycleOptions } from './types';
import type { Lifecycle, Member } from './types';

export interface RowActionsProps {
  member: Member;
  /** The membership of the signed-in user: nobody acts on themselves (SELF_ACTION_DENIED), so no control is shown for it. */
  selfId: string | undefined;
  /** Whether suspend, reactivate and end are offered (iam.member.manage); the server still decides. */
  canManage: boolean;
  onAction(action: Lifecycle, member: Member): void;
}

/** The lifecycle commands the status of a membership allows, as one button each; none for a read-only user, for oneself or for a member the server says the reader does not outrank (BR-IAM-05). */
export function RowActions({ member, selfId, canManage, onAction }: RowActionsProps) {
  const { t } = useTranslation();
  if (!canManage || member.id === selfId || member.canManage === false) return null;
  return (
    <>
      {lifecycleOptions(member.status).map((action) => (
        <button key={action} type="button" className={action === 'end' ? 'ui-button ui-button--outline ui-button--small danger' : 'ui-button ui-button--outline ui-button--small'} aria-label={lifecycleRowLabel(t, action, member)} onClick={() => onAction(action, member)}>
          {lifecycleAction(t, action)}
        </button>
      ))}
    </>
  );
}
