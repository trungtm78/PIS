import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { memberRoleLabel, roleLabel } from '../accountability-labels';
import { ASSIGNMENTS_PATH, ASSIGN_PERMISSION, TASK_FORCES_PATH, TASK_FORCE_PERMISSION } from '../accountability-model';
import { useAssignments, useTaskForces } from '../accountability-reads';
import { useProjects } from '../hooks';
import { READ_PERMISSION } from '../model';
import { holds } from '../plan/model';
import '../prj.css';
import { ProjectChooser, useProjectParam } from '../revision/shared';
import { TASK_FORCE_READ_PERMISSION, mayRead, teamOf } from './model';
import type { TeamRow } from './model';

type T = Translator['t'];

const validityText = (t: T, row: TeamRow): string =>
  row.validUntil === null ? t('prj.team.validity.open', { from: row.validFrom }) : t('prj.team.validity.range', { from: row.validFrom, until: row.validUntil });

/**
 * PRJ-08: the team that carries a project through (ST-PRJ-011): who answers for it in the register of assignments, and the members of the task forces whose term is on it. Nothing is changed here; whoever may administer
 * assignments or task forces is sent to PRJ-17 and PRJ-18. The task forces are read only by whoever may read them; without that right the screen says so instead of showing a team that looks complete.
 */
export default function TeamScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam({ fallbackToFirst: true });
  // The team is read for one person in one tenant and one project: a move to another starts the screen over.
  return <TeamContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function TeamContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const { projectId, choose } = useProjectParam({ fallbackToFirst: true });
  const readable = mayRead(permissions, READ_PERMISSION);
  const forcesReadable = mayRead(permissions, TASK_FORCE_READ_PERMISSION);
  const asked = readable && projectId !== undefined;
  const projects = useProjects();
  const assignments = useAssignments(asked);
  const forces = useTaskForces(asked && forcesReadable);
  const project = (projects.data ?? []).find((candidate) => candidate.id === projectId);
  const ready = projects.data !== undefined && assignments.data !== undefined && (!forcesReadable || forces.data !== undefined);
  const rows = !ready ? undefined : project === undefined ? [] : teamOf(project, assignments.data ?? [], forces.data ?? []);
  const state = useScreenState({
    isLoading: asked && (projects.isLoading || assignments.isLoading || forces.isLoading),
    error: asked ? (projects.error ?? assignments.error ?? forces.error) : undefined,
    data: asked ? rows : undefined,
  });
  const retry = () => void Promise.all([projects.refetch(), assignments.refetch(), forcesReadable ? forces.refetch() : undefined]);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.team.page.title')}</h1>
          <p>{t('prj.team.page.subtitle')}</p>
        </div>
      </div>
      {readable ? <ProjectChooser id="team-project" projectId={projectId} choose={choose} /> : null}
      {readable && projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={readable ? state : 'denied'} onRetry={retry}>
          {forcesReadable ? null : (
            <p className="callout" role="status" data-testid="forces-hidden">
              {t('prj.team.forces.hidden.notice')}
            </p>
          )}
          <div className="tablewrap">
            <table className="table" aria-label={t('prj.team.table.aria')} data-testid="team">
              <thead>
                <tr>
                  <th scope="col">{t('prj.team.column.member')}</th>
                  <th scope="col">{t('prj.team.column.role')}</th>
                  <th scope="col">{t('prj.team.column.scope')}</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => (
                  <tr key={row.key} data-kind={row.kind} data-role={row.role}>
                    <th scope="row">{row.person ?? t('prj.team.member.unknown')}</th>
                    <td>{row.kind === 'assignment' ? roleLabel(t, row.role) : memberRoleLabel(t, row.role)}</td>
                    <td>
                      {row.kind === 'assignment'
                        ? t('prj.team.scope.project', { project: `${project?.code ?? ''} ${project?.name ?? ''}`.trim() })
                        : t('prj.team.scope.force', { code: row.forceCode, name: row.forceName })}
                      <small className="sub">
                        {' '}
                        {row.kind === 'taskForce' ? `${t('prj.team.scope.unit', { unit: row.scopeUnit })} · ` : ''}
                        {validityText(t, row)}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {holds(permissions, ASSIGN_PERMISSION, mode) ? (
              <Link className="button" to={ASSIGNMENTS_PATH} data-testid="manage-assignments">
                {t('prj.team.manage.assignments.action')}
              </Link>
            ) : null}{' '}
            {holds(permissions, TASK_FORCE_PERMISSION, mode) ? (
              <Link className="button" to={TASK_FORCES_PATH} data-testid="manage-forces">
                {t('prj.team.manage.forces.action')}
              </Link>
            ) : null}
          </p>
        </StateBoundary>
      )}
    </section>
  );
}
