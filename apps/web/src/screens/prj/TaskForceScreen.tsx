import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AddMemberDialog, DissolveDialog } from './TaskForceDialogs';
import { TaskForceForm } from './TaskForceForm';
import { TaskForceTable } from './TaskForceTable';
import { TASK_FORCE_PERMISSION } from './accountability-model';
import type { Option, TaskForceLine } from './accountability-model';
import { useMemberOptions, useTaskForces } from './accountability-reads';
import { useProjects, useUnits } from './hooks';
import { useWholeTenantAuthority } from './national-code-import-hooks';
import './prj.css';

/**
 * PRJ-18: the task forces that press the disbursement of the projects of an area (ST-PRJ-005, PRJ 3.1 F9; Directive 162/CD-TTg). Founding a force,
 * seating a member and dissolving it are for the office that administers them on the whole tenant; whoever may only read sees the forces and their
 * terms without the forms.
 */
export default function TaskForceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <TaskForceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'member'; force: TaskForceLine } | { kind: 'dissolve'; force: TaskForceLine };

function TaskForceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayManage = (permissions === undefined || permissions.includes(TASK_FORCE_PERMISSION)) && mode !== 'READ_ONLY';
  // The commands are for whoever holds the permission on the whole tenant; a caller whose permissions are not known is judged by the server.
  const authority = useWholeTenantAuthority(TASK_FORCE_PERMISSION, mayManage && permissions !== undefined);
  const wholeTenant = permissions === undefined ? true : authority;
  const canManage = mayManage && wholeTenant === true;
  const forces = useTaskForces();
  const projects = useProjects();
  const units = useUnits(canManage);
  const members = useMemberOptions(canManage);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: forces.isLoading, error: forces.error, data: forces.data, isEmpty: () => false });
  const projectOptions = useMemo<Option[]>(() => (projects.data ?? []).map((project) => ({ id: project.id, label: `${project.code} ${project.name}` })), [projects.data]);
  const unitOptions = useMemo<Option[]>(() => (units.data ?? []).map((unit) => ({ id: unit.id, label: `${unit.code} ${unit.name}`.trim() })), [units.data]);
  const close = (): void => setDialog(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.taskforce.page.title')}</h1>
          <p>{t('prj.taskforce.page.subtitle')}</p>
        </div>
      </div>
      {mayManage && wholeTenant === false ? (
        <p className="callout" role="status" data-testid="whole-tenant-notice">
          {t('prj.taskforce.wholeTenant.notice')}
        </p>
      ) : null}
      {canManage ? <TaskForceForm members={members.data ?? []} units={unitOptions} /> : null}
      <StateBoundary state={state} onRetry={() => void forces.refetch()}>
        <TaskForceTable forces={forces.data ?? []} canManage={canManage} onAddMember={(force) => setDialog({ kind: 'member', force })} onDissolve={(force) => setDialog({ kind: 'dissolve', force })} />
      </StateBoundary>
      {dialog?.kind === 'member' ? <AddMemberDialog force={dialog.force} members={members.data ?? []} projects={projectOptions} onClose={close} /> : null}
      {dialog?.kind === 'dissolve' ? <DissolveDialog force={dialog.force} onClose={close} /> : null}
      <p className="prototype-note">{t('prj.taskforce.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
