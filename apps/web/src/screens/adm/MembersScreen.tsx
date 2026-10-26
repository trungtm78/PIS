import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DevAcceptanceSlot } from './members/DevAcceptanceSlot';
import { InviteMemberDialog } from './members/InviteMemberDialog';
import { LifecycleDialog } from './members/LifecycleDialog';
import { RowActions } from './members/RowActions';
import { useMembers, useSeatUsage, useUnits } from './members/hooks';
import { dayOf, invitationLabel, lifecycleDone, seatCountText, statusLabel, statusPill, typeLabel } from './members/labels';
import { MEMBERSHIP_STATUSES, MEMBERSHIP_TYPES, PERMISSION_INVITE, PERMISSION_MANAGE, PERMISSION_READ, PERMISSION_USAGE } from './members/types';
import type { Lifecycle, Member, MembershipStatus, MembershipType } from './members/types';
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

  return (
    <section data-screen-id={routeId} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.members.page.title')}</h1>
          <p>{t('adm.members.page.subtitle')}</p>
        </div>
        {(state === 'default' || state === 'empty') && canInvite ? (
          <div className="actions">
            <button type="button" className="primary" onClick={() => setInviting(true)}>
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
        <div className="card">
          <form className="filters" onSubmit={submit}>
            <div>
              <label htmlFor="member-search">{t('adm.members.search.label')}</label>
              <input id="member-search" type="search" value={draft.text} placeholder={t('adm.members.search.placeholder')} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
            </div>
            <div>
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
            <div>
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
            <button type="submit">{t('adm.members.filter.action')}</button>
          </form>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('adm.members.col.account')}</th>
                  <th>{t('adm.members.col.roles')}</th>
                  <th>{t('adm.members.col.unit')}</th>
                  <th>{t('adm.members.col.type')}</th>
                  <th>{t('adm.members.col.invitation')}</th>
                  <th>{t('adm.members.col.validUntil')}</th>
                  <th>{t('adm.members.col.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((member) => (
                  <tr key={member.id} data-member-id={member.id}>
                    <td>
                      <strong>{member.displayName}</strong>
                      <div className="sub">{member.email}</div>
                    </td>
                    <td>{member.roleCodes.length === 0 ? t('adm.members.roles.none') : member.roleCodes.join(', ')}</td>
                    <td>{unitNames.get(member.organizationId) ?? member.organizationId.slice(-SHORT_ID)}</td>
                    <td>{typeLabel(t, member.membershipType)}</td>
                    <td>{invitationLabel(t, member.invitationStatus)}</td>
                    <td>{member.validUntil === null ? t('adm.members.validUntil.open') : dayOf(member.validUntil)}</td>
                    <td>
                      <span className={statusPill(member.status)}>{statusLabel(t, member.status)}</span>
                    </td>
                    <td className="members-actions">
                      <RowActions member={member} selfId={tenant?.membershipId} canManage={canManage} onAction={(action, target) => setActing({ action, member: target })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 ? <p className="muted">{t('adm.members.filtered.empty')}</p> : null}
          <div className="row between gap tiny muted">
            <span>{t('adm.members.count.text', { count: shown.length })}</span>
            {list.hasNextPage ? (
              <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('adm.members.more.action')}
              </button>
            ) : null}
          </div>
        </div>
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
