import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useProject } from '../../prj/hooks';
import { PATHS } from '../model';
import { WorkflowBody } from './WorkflowBody';

/** PWF-03: the workflow of one project (`?id=` names the project) as a screen of its own; the same body is the tab "Workflow" of PRJ-03. */
export default function WorkflowScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What the screen shows depends on the places the signed-in membership reaches: a switch of tenant or membership starts it over.
  return <WorkflowContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkflowContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const projectId = params.get('id') ?? undefined;
  const project = useProject(projectId);
  const name = project.data === undefined || project.data === null ? undefined : `${project.data.code} · ${project.data.name}`;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {projectId === undefined ? null : (
        <p className="prj-back-link">
          <Link to={`${PATHS.project}?id=${encodeURIComponent(projectId)}`}>{t('pwf.flow.back.link')}</Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwf.flow.page.title')}</h1>
          <p>{name ?? t('pwf.flow.page.subtitle')}</p>
        </div>
      </div>
      {projectId === undefined ? (
        <p className="callout warning" role="status" data-testid="no-project">
          {t('pwf.flow.noProject.notice')}
        </p>
      ) : (
        <WorkflowBody projectId={projectId} />
      )}
      <p className="prototype-note">{t('prj.workspace.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
