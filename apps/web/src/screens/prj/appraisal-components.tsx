import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { DECISION_PATH, SCORE_PATH, appraisalLink } from './appraisal-model';
import type { CriteriaSet } from './appraisal-model';
import { BackLink } from './components';
import { stageLabel } from './labels';
import { workspaceLink } from './model';
import type { ProjectStatus } from './model';
import './prj.css';

export interface FrameProps {
  route: ScreenProps['route'];
  title: string;
  subtitle: string;
  project: { id: string; code: string; name?: string; status: ProjectStatus } | undefined;
  children: ReactNode;
}

/** The frame the three screens of the appraisal share: the way back, the title, the project and its stage, and the reference of the screen. */
export function AppraisalFrame({ route, title, subtitle, project, children }: FrameProps) {
  const { t } = useTranslation();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {project === undefined ? null : <BackLink to={workspaceLink(project.id)}>{t('prj.appraisal.back.workspace.link')}</BackLink>}
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
          {project === undefined ? null : (
            <p data-testid="project-head">
              <code>{project.code}</code>
              {project.name === undefined ? null : <> · {project.name}</>}{' '}
              <span className="prj-badge" data-testid="stage">
                {stageLabel(t, project.status)}
              </span>
            </p>
          )}
        </div>
      </div>
      {children}
      <p className="prototype-note">{t('prj.appraisal.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The links between the screens of the appraisal for one project, so that a person at one finds the others. */
export function AppraisalLinks({ projectId, current }: { projectId: string; current: 'score' | 'decision' }) {
  const { t } = useTranslation();
  return (
    <p className="prj-links" data-testid="appraisal-links">
      {current === 'decision' ? <Link to={appraisalLink(SCORE_PATH, projectId)}>{t('prj.appraisal.link.score.text')}</Link> : <Link to={appraisalLink(DECISION_PATH, projectId)}>{t('prj.appraisal.link.decision.text')}</Link>}
    </p>
  );
}

/** The set of criteria in force, the threshold, and the badge that a set waiting for its confirmation must carry (a state is never told by colour alone). */
export function CriteriaBasis({ set }: { set: CriteriaSet }) {
  const { t } = useTranslation();
  return (
    <div data-testid="criteria-basis">
      <p>{t('prj.appraisal.set.threshold.text', { threshold: set.passThreshold, key: set.key })}</p>
      {set.awaitingConfirmation ? (
        <p>
          <span className="prj-badge warning" data-testid="set-awaiting">
            {set.cxn === null ? t('prj.appraisal.set.awaiting.badge') : t('prj.appraisal.set.awaitingCxn.badge', { cxn: set.cxn })}
          </span>
        </p>
      ) : null}
      {set.legalBasis === '' ? null : <p className="sub">{t('prj.appraisal.set.basis.text', { basis: set.legalBasis, revision: set.revision })}</p>}
    </div>
  );
}
