import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AssignLeaderForm } from './AssignLeaderForm';
import { AssignmentTable } from './AssignmentTable';
import { EndAssignmentDialog } from './EndAssignmentDialog';
import { ASSIGN_PERMISSION } from './accountability-model';
import type { AssignmentLine, Option } from './accountability-model';
import { useAssignments, useMemberOptions } from './accountability-reads';
import { useProjects } from './hooks';
import { useWholeTenantAuthority } from './national-code-import-hooks';
import './prj.css';

/**
 * PRJ-17: who answers for each project (ST-PRJ-005, PRJ 3.1 F9, BR-PRJ-10; Directive 162/CD-TTg). The register keeps the history: an assignment is
 * ended with a day and a reason, never edited. Making and ending assignments is for the office that administers them on the whole tenant; whoever
 * may only read sees the register without the forms.
 */
export default function AccountabilityScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The register belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <AccountabilityContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AccountabilityContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayAssign = (permissions === undefined || permissions.includes(ASSIGN_PERMISSION)) && mode !== 'READ_ONLY';
  // The commands are for whoever holds the permission on the whole tenant; a caller whose permissions are not known is judged by the server.
  const authority = useWholeTenantAuthority(ASSIGN_PERMISSION, mayAssign && permissions !== undefined);
  const wholeTenant = permissions === undefined ? true : authority;
  const canAssign = mayAssign && wholeTenant === true;
  const assignments = useAssignments();
  const projects = useProjects();
  const members = useMemberOptions(canAssign);
  const [ending, setEnding] = useState<AssignmentLine | undefined>(undefined);
  const state = useScreenState({ isLoading: assignments.isLoading, error: assignments.error, data: assignments.data, isEmpty: () => false });
  const projectOptions = useMemo<Option[]>(() => (projects.data ?? []).map((project) => ({ id: project.id, label: `${project.code} ${project.name}` })), [projects.data]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.accountability.page.title')}</h1>
          <p>{t('prj.accountability.page.subtitle')}</p>
        </div>
      </div>
      {mayAssign && wholeTenant === false ? (
        <p className="callout" role="status" data-testid="whole-tenant-notice">
          {t('prj.accountability.wholeTenant.notice')}
        </p>
      ) : null}
      {canAssign ? <AssignLeaderForm projects={projectOptions} members={members.data ?? []} /> : null}
      <StateBoundary state={state} onRetry={() => void assignments.refetch()}>
        <div className="card">
          <AssignmentTable lines={assignments.data ?? []} canEnd={canAssign} onEnd={setEnding} />
        </div>
      </StateBoundary>
      {ending === undefined ? null : <EndAssignmentDialog line={ending} onClose={() => setEnding(undefined)} />}
      <p className="prototype-note">{t('prj.accountability.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
