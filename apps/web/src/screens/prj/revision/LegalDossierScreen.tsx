import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../prj.css';
import { useRevisions } from './hooks';
import { dossierOf } from './model';
import { NONE, ProjectChooser, documentText, statusLabel, statusTone, useProjectParam } from './shared';

/**
 * PRJ-04: the legal dossier of a project (ST-PRJ-008). It lists the decision documents that ground the figures of the project: the decision number, the day it takes effect and the revision it belongs to. It only
 * lists references; the documents themselves are written and kept in DOC.
 */
export default function LegalDossierScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam();
  return <DossierContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function DossierContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { projectId, choose } = useProjectParam();
  const list = useRevisions(projectId);
  const documents = dossierOf(list.data?.items ?? []);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: projectId === undefined || list.data === undefined ? undefined : documents, isEmpty: () => documents.length === 0 });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.dossier.page.title')}</h1>
          <p>{t('prj.dossier.page.subtitle')}</p>
        </div>
      </div>
      <ProjectChooser id="dossier-project" projectId={projectId} choose={choose} />
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <div className="tablewrap">
            <table className="table" aria-label={t('prj.dossier.list.aria')} data-testid="dossier">
              <thead>
                <tr>
                  <th scope="col">{t('prj.dossier.col.number')}</th>
                  <th scope="col">{t('prj.dossier.col.effective')}</th>
                  <th scope="col">{t('prj.dossier.col.revision')}</th>
                  <th scope="col">{t('prj.dossier.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((item) => (
                  <tr key={item.id} data-revision={item.id}>
                    <td>
                      {item.document === null ? NONE : documentText(t, item.document)}
                      <span className="prj-code">{item.document?.title}</span>
                    </td>
                    <td>{item.effectiveFrom ?? NONE}</td>
                    <td>{t('prj.revision.row.number', { revision: item.revision })}</td>
                    <td>
                      <span className={`pill ${statusTone(item.status)}`}>{statusLabel(t, item.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="prj-links">
            <Link to={`/prj/prj-06?id=${projectId}`}>{t('prj.dossier.revisions.link')}</Link>
          </p>
        </StateBoundary>
      )}
      <p className="prototype-note">{t('prj.revision.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
