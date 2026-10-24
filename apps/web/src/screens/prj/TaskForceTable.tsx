import { useTranslation } from '../../i18n';
import { memberRoleLabel, taskForceStatusLabel } from './accountability-labels';
import type { TaskForceLine } from './accountability-model';
import './prj.css';

export interface TaskForceTableProps {
  forces: readonly TaskForceLine[];
  /** The caller may manage task forces and the session is not read-only. */
  canManage: boolean;
  onAddMember(force: TaskForceLine): void;
  onDissolve(force: TaskForceLine): void;
}

/**
 * The task forces of PRJ-18: for each, its code and purpose, the unit whose subtree is its scope, the lead, and the terms of the members (the open ones
 * first, the ended ones kept as history) with the project each follows. A state is told in words, never by colour alone.
 */
export function TaskForceTable({ forces, canManage, onAddMember, onDissolve }: TaskForceTableProps) {
  const { t } = useTranslation();
  if (forces.length === 0) {
    return (
      <p role="status" data-testid="forces-empty">
        {t('prj.taskforce.list.empty.notice')}
      </p>
    );
  }
  return (
    <div data-testid="forces">
      {forces.map((force) => (
        <article key={force.id} className="card" data-force-id={force.id} data-status={force.status} aria-label={t('prj.taskforce.card.aria', { code: force.code })}>
          <h2>
            {force.code} · {force.name}
          </h2>
          <p className="sub">{force.purpose}</p>
          <dl>
            <dt>{t('prj.taskforce.card.status.label')}</dt>
            <dd>{taskForceStatusLabel(t, force.status)}</dd>
            <dt>{t('prj.taskforce.card.lead.label')}</dt>
            <dd>{force.leadName ?? t('prj.taskforce.card.lead.unknown')}</dd>
            <dt>{t('prj.taskforce.card.scope.label')}</dt>
            <dd>{force.scopeUnitName}</dd>
            <dt>{t('prj.taskforce.card.period.label')}</dt>
            <dd>
              {force.validFrom} → {force.validUntil ?? t('prj.taskforce.card.period.open')}
            </dd>
            <dt>{t('prj.taskforce.card.document.label')}</dt>
            <dd>{force.documentId ?? t('prj.taskforce.card.document.none')}</dd>
          </dl>
          <table className="table" aria-label={t('prj.taskforce.members.aria', { code: force.code })}>
            <thead>
              <tr>
                <th scope="col">{t('prj.taskforce.members.person')}</th>
                <th scope="col">{t('prj.taskforce.members.role')}</th>
                <th scope="col">{t('prj.taskforce.members.project')}</th>
                <th scope="col">{t('prj.taskforce.members.term')}</th>
              </tr>
            </thead>
            <tbody>
              {force.members.map((member) => (
                <tr key={member.id} data-member-id={member.id} data-ended={member.validUntil === null ? 'false' : 'true'}>
                  <th scope="row">{member.displayName ?? t('prj.taskforce.members.unknown')}</th>
                  <td>{memberRoleLabel(t, member.role)}</td>
                  <td>{member.projectCode === null ? t('prj.taskforce.members.project.none') : `${member.projectCode} ${member.projectName ?? ''}`.trim()}</td>
                  <td>
                    {member.validFrom} → {member.validUntil ?? t('prj.taskforce.card.period.open')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canManage && force.status === 'ACTIVE' ? (
            <div className="formfooter">
              <button type="button" onClick={() => onAddMember(force)}>
                {t('prj.taskforce.member.action', { code: force.code })}
              </button>
              <button type="button" onClick={() => onDissolve(force)}>
                {t('prj.taskforce.dissolve.action', { code: force.code })}
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
