import { useRef, useState } from 'react';
import type { ScreenProps } from '../../routes/types';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { GrantDialog } from './roles/GrantDialog';
import { GrantList } from './roles/GrantList';
import { useGrantableRoles, useGrants, useRoleDefinitions } from './roles/hooks';
import { RoleForm } from './roles/RoleForm';
import { RolePreview } from './roles/RolePreview';
import { RevokeDialog } from './roles/RevokeDialog';
import { PERMISSION_GRANT, PERMISSION_MANAGE, PERMISSION_READ } from './roles/types';
import type { GrantView } from './roles/types';
import './roles/roles.css';

type Selection = { kind: 'role'; id: string } | { kind: 'new' } | { kind: 'none' };
type Notice = 'created' | 'saved' | 'granted' | 'revoked';

/** Whether the user holds a permission; unknown permissions (no list in the session) leave the decision to the server. */
function holds(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes(permission);
}

/**
 * ADM-03 roles and permissions (FR-ADM-03): roles with their resource x action matrix, the grants of the user's scope,
 * and the commands createCustomRole, updateCustomRole, grantRole and revokeRoleGrant. Reads need role_grant.read;
 * the commands need iam.role.manage and iam.role.grant. Without them the screen is read-only or denied.
 */
export default function RolesGrantsScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (selection, drafts, dialogs) belongs to one tenant: a switch starts it over, so a
  // draft typed for one tenant can never be saved into another.
  return <RolesGrantsContent key={tenantId ?? 'none'} routeId={route.id} />;
}

function RolesGrantsContent({ routeId }: { routeId: string }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canRead = holds(permissions, PERMISSION_READ);
  const canGrant = holds(permissions, PERMISSION_GRANT) && !frozen;
  const canManage = holds(permissions, PERMISSION_MANAGE) && !frozen;

  const roles = useRoleDefinitions(canRead);
  const grants = useGrants(canRead);
  const grantable = useGrantableRoles(canRead && canGrant);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<GrantView | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  // Bumped to mount the role form again from the fresh server data (after a save, or on request).
  const [formVersion, setFormVersion] = useState(0);
  // Which form is open now ('new', a role id or none). A save belongs to the form it was started from.
  const openForm = selection.kind === 'role' ? selection.id : selection.kind === 'new' ? 'new' : undefined;
  const openFormRef = useRef(openForm);
  openFormRef.current = openForm;
  const finishSave = (kind: 'created' | 'saved', submittedFrom: string | undefined): void => {
    setNotice(kind);
    // The user may have moved to another role or to a new one while the command ran: that form and its draft stay as they are.
    if (openFormRef.current !== submittedFrom) return;
    if (kind === 'created') setSelection({ kind: 'none' });
    else setFormVersion((current) => current + 1);
  };

  const loaded = roles.data !== undefined && grants.data !== undefined;
  const queryState = useScreenState({
    isLoading: roles.isLoading || grants.isLoading,
    error: roles.error ?? grants.error ?? undefined,
    data: loaded ? { roles: roles.data, grants: grants.data } : undefined,
    isEmpty: () => (roles.data?.length ?? 0) === 0 && (grants.data?.length ?? 0) === 0,
  });
  // Without role_grant.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  const retry = (): void => {
    void roles.refetch();
    void grants.refetch();
  };

  const selected = selection.kind === 'role' ? roles.data?.find((role) => role.id === selection.id) : undefined;

  return (
    <section data-screen-id={routeId}>
      <div className="heading">
        <div>
          <h1>{t('adm.roles.page.title')}</h1>
          <p>{t('adm.roles.page.subtitle')}</p>
        </div>
        {state === 'default' ? (
          <div className="actions">
            {canManage ? (
              <button type="button" onClick={() => setSelection({ kind: 'new' })}>
                {t('adm.roles.action.create')}
              </button>
            ) : null}
            {canGrant ? (
              <button type="button" className="primary" onClick={() => setGranting(true)}>
                {t('adm.roles.action.grant')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={retry}>
        {notice === undefined ? null : (
          <div className="callout" role="status">
            {notice === 'created' ? t('adm.roles.notice.created') : null}
            {notice === 'saved' ? t('adm.roles.notice.saved') : null}
            {notice === 'granted' ? t('adm.roles.notice.granted') : null}
            {notice === 'revoked' ? t('adm.roles.notice.revoked') : null}
          </div>
        )}
        <div className="two">
          <div className="card">
            <div className="row between">
              <h2>{t('adm.roles.card.title')}</h2>
              {selected === undefined ? null : <span className="pill gray">{t('adm.roles.version.label', { version: selected.version })}</span>}
            </div>
            <div className="field">
              <label htmlFor="role-picker">{t('adm.roles.picker.label')}</label>
              <select
                id="role-picker"
                value={selection.kind === 'role' ? selection.id : ''}
                onChange={(event) => setSelection(event.target.value === '' ? { kind: 'none' } : { kind: 'role', id: event.target.value })}
              >
                <option value="">{t('adm.roles.picker.placeholder')}</option>
                {(roles.data ?? []).map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.code}
                  </option>
                ))}
              </select>
            </div>
            {selection.kind === 'none' ? null : (
              <RoleForm
                key={`${selection.kind === 'role' ? selection.id : 'new'}:${formVersion}`}
                role={selected}
                canManage={canManage}
                onSaved={(kind) => finishSave(kind, openForm)}
                onReload={() => setFormVersion((current) => current + 1)}
              />
            )}
          </div>
          <RolePreview role={selected} />
        </div>
        <div className="card">
          <h2>{t('adm.roles.grants.title')}</h2>
          <GrantList grants={grants.data ?? []} canRevoke={canGrant} onRevoke={setRevoking} />
        </div>
      </StateBoundary>
      {granting ? (
        <GrantDialog
          roles={grantable.data ?? []}
          rolesStatus={{
            state: grantable.isError ? 'error' : grantable.data === undefined ? 'loading' : 'ready',
            error: grantable.error,
            onRetry: () => void grantable.refetch(),
          }}
          onClose={() => setGranting(false)}
          onGranted={() => {
            setGranting(false);
            setNotice('granted');
          }}
        />
      ) : null}
      {revoking === undefined ? null : (
        <RevokeDialog
          grant={revoking}
          onClose={() => setRevoking(undefined)}
          onRevoked={() => {
            setRevoking(undefined);
            setNotice('revoked');
          }}
        />
      )}
    </section>
  );
}
