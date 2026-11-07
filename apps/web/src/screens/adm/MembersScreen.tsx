import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, FilterPanel, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { DevAcceptanceSlot } from './members/DevAcceptanceSlot';
import { InviteMemberDialog } from './members/InviteMemberDialog';
import { LifecycleDialog } from './members/LifecycleDialog';
import { RowActions } from './members/RowActions';
import { useMembers, useSeatUsage, useUnits } from './members/hooks';
import { dayOf, invitationLabel, lifecycleDone, seatCountText, statusLabel, statusTone, typeLabel } from './members/labels';
import { MEMBERSHIP_STATUSES, MEMBERSHIP_TYPES, PERMISSION_INVITE, PERMISSION_MANAGE, PERMISSION_READ, PERMISSION_USAGE } from './members/types';
import type { Lifecycle, Member, MembershipStatus, MembershipType } from './members/types';
import './adm-kit.css';
import './members/members.css';

interface Filter {
  text: string;
  status: MembershipStatus | '';
  type: MembershipType | '';
}

const NO_FILTER: Filter = { text: '', status: '', type: '' };
const SHORT_ID = 8;

type Notice = { kind: 'invited'; email: string } | { kind: 'changed'; text: string };

/** Whether the user holds a permission; unknown permissions (no list in the session) leave the decision to the server. */
function holds(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions === undefined || permissions.includes(permission);
}

const matches = (member: Member, filter: Filter): boolean =>
  (filter.status === '' || member.status === filter.status) &&
  (filter.type === '' || member.membershipType === filter.type) &&
  (filter.text === '' || `${member.displayName} ${member.email}`.toLowerCase().includes(filter.text.toLowerCase()));

/**
 * ADM-02 users and invitations (FR-ADM-02): the memberships of the units the user's grants reach, with the commands
 * inviteMember, suspendMembership, reactivateMembership and endMembership. Reads need membership.read, the commands
 * iam.member.invite and iam.member.manage; without them the screen is read-only or denied.
 */
export default function MembersScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (filters, dialogs, notices) belongs to one tenant: a switch starts it over.
  return <MembersContent key={tenantId ?? 'none'} routeId={route.id} requirement={route.req ?? ''} />;
}

function MembersContent({ routeId, requirement }: { routeId: string; requirement: string }) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canRead = holds(permissions, PERMISSION_READ);
  const canInvite = holds(permissions, PERMISSION_INVITE) && !frozen;
  const canManage = holds(permissions, PERMISSION_MANAGE) && !frozen;

  const list = useMembers(undefined, canRead);
  const units = useUnits(canRead);
  // The seats are advice beside the list: a reader without the right to see the subscription, or a failed read, simply has no line.
  const seats = useSeatUsage(canRead && holds(permissions, PERMISSION_USAGE));
  const [draft, setDraft] = useState<Filter>(NO_FILTER);
  const [applied, setApplied] = useState<Filter>(NO_FILTER);
  const [inviting, setInviting] = useState(false);
  const [acting, setActing] = useState<{ action: Lifecycle; member: Member } | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const all = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const shown = useMemo(() => all.filter((member) => matches(member, applied)), [all, applied]);
  const unitNames = useMemo(() => new Map((units.data ?? []).map((unit) => [unit.id, unit.name === '' ? unit.code : unit.name])), [units.data]);
  const queryState = useScreenState({ isLoading: list.isLoading, error: list.error ?? undefined, data: list.data === undefined ? undefined : all });
  // Without membership.read nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
  };

  const appliedCount = [applied.text, applied.status, applied.type].filter((value) => value !== '').length;
  const columns: DataTableColumn<Member>[] = [
    {
      key: 'account',
      header: t('adm.members.col.account'),
      pinned: true,
      render: (member) => (
        <span data-member-id={member.id}>
          <strong>{member.displayName}</strong>
          <span className="adm-kit-sub">{member.email}</span>
        </span>
      ),
    },
    { key: 'roles', header: t('adm.members.col.roles'), render: (member) => (member.roleCodes.length === 0 ? t('adm.members.roles.none') : member.roleCodes.join(', ')) },
    { key: 'unit', header: t('adm.members.col.unit'), render: (member) => unitNames.get(member.organizationId) ?? member.organizationId.slice(-SHORT_ID) },
    { key: 'type', header: t('adm.members.col.type'), render: (member) => typeLabel(t, member.membershipType) },
    { key: 'invitation', header: t('adm.members.col.invitation'), render: (member) => invitationLabel(t, member.invitationStatus) },
    { key: 'validUntil', header: t('adm.members.col.validUntil'), render: (member) => (member.validUntil === null ? t('adm.members.validUntil.open') : dayOf(member.validUntil)) },
    { key: 'status', header: t('adm.members.col.status'), render: (member) => <StatusPill tone={statusTone(member.status)}>{statusLabel(t, member.status)}</StatusPill> },
    {
      key: 'actions',
      header: t('ui.stickyActions.label'),
      render: (member) => (
        <div className="members-actions">
          <RowActions member={member} selfId={tenant?.membershipId} canManage={canManage} onAction={(action, target) => setActing({ action, member: target })} />
        </div>
      ),
    },
  ];

  return (
    <section data-screen-id={routeId} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.members.page.title')}</h1>
          <p>{t('adm.members.page.subtitle')}</p>
        </div>
        {(state === 'default' || state === 'empty') && canInvite ? (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setInviting(true)}>
              {t('adm.members.invite.action')}
            </button>
          </div>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {notice === undefined ? null : (
          <div className="callout" role="status">
            {notice.kind === 'invited' ? t('adm.members.notice.invited', { email: notice.email }) : notice.text}
            {notice.kind === 'invited' ? <DevAcceptanceSlot email={notice.email} /> : null}
          </div>
        )}
        {seats.data === undefined ? null : (
          <p className="sub" data-seats="">
            {t('adm.members.seats.text', { staff: seatCountText(t, seats.data.staff), guests: seatCountText(t, seats.data.guests) })}
          </p>
        )}
        <form className="adm-kit-form" onSubmit={submit} aria-label={t('adm.members.filter.action')}>
          <FilterPanel
            applied={appliedCount}
            actions={
              <button type="submit" className="ui-button ui-button--primary">
                {t('adm.members.filter.action')}
              </button>
            }
          >
            <div className="field">
              <label htmlFor="member-search">{t('adm.members.search.label')}</label>
              <input id="member-search" type="search" value={draft.text} placeholder={t('adm.members.search.placeholder')} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="member-type">{t('adm.members.type.label')}</label>
              <select id="member-type" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as MembershipType | '' })}>
                <option value="">{t('adm.members.type.all')}</option>
                {MEMBERSHIP_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {typeLabel(t, type)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="member-status">{t('adm.members.status.label')}</label>
              <select id="member-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as MembershipStatus | '' })}>
                <option value="">{t('adm.members.status.all')}</option>
                {MEMBERSHIP_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
          </FilterPanel>
        </form>
        <SectionCard title={t('adm.members.page.title')}>
          {shown.length === 0 ? (
            <p className="adm-kit-empty" role="status">
              {t('adm.members.filtered.empty')}
            </p>
          ) : (
            <DataTable caption={t('w2adm.members.table.caption')} columns={columns} rows={shown} rowKey={(member) => member.id} rowAttrs={(member) => ({ 'data-member-id': member.id })} />
          )}
          <div className="adm-kit-foot">
            <span>{t('adm.members.count.text', { count: shown.length })}</span>
            {list.hasNextPage ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('adm.members.more.action')}
              </button>
            ) : null}
          </div>
        </SectionCard>
      </StateBoundary>
      {inviting ? (
        <InviteMemberDialog
          onClose={() => setInviting(false)}
          onInvited={(email) => {
            setInviting(false);
            setNotice({ kind: 'invited', email });
          }}
        />
      ) : null}
      {acting === undefined ? null : (
        <LifecycleDialog
          action={acting.action}
          member={acting.member}
          onClose={() => setActing(undefined)}
          onDone={() => {
            setNotice({ kind: 'changed', text: lifecycleDone(t, acting.action, acting.member) });
            setActing(undefined);
          }}
        />
      )}
      <p className="prototype-note">{t('adm.members.footer.reference', { id: routeId, req: requirement })}</p>
    </section>
  );
}
