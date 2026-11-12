import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ContextBar } from '../../../../ui';
import { dayText } from '../shared/format';
import { useInvestmentProfile, useProjectOptions } from './hooks';
import { yearProblem } from './model';
import { ClassificationSection, FindingsSection, LegalDocumentsSection, MilestonesSection, OriginSplitSection } from './sections';
import '../shared/shared.css';
import './ipf.css';

/**
 * IPF-01: the investment profile of one project of the enterprise edition (MD.01, MD.02, CN.01 of the customer spec). It reads `getProjectInvestmentProfile` and draws what the register holds, in the scope of the caller:
 * the type of the project and whether it starts in the plan year or carries over, the milestones of the investment life against the catalogue (state, order, the required one that was skipped), the legal documents by
 * type of the catalogue and what each milestone asks as evidence, and the plan split by origin (the resolution of the group against the decision of the company) with the documents behind it. Nothing is written here.
 * A project outside the scope of the caller is as absent as one that does not exist.
 */
export default function InvestmentProfileScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <InvestmentProfileContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function InvestmentProfileContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const yearText = params.get('plan_year') ?? '';
  const [draftProject, setDraftProject] = useState(projectId ?? '');
  const [draftYear, setDraftYear] = useState(yearText);
  const problem = yearProblem(draftYear);
  const askedYear = yearProblem(yearText) === undefined && yearText !== '' ? Number(yearText) : undefined;

  const projects = useProjectOptions();
  const profile = useInvestmentProfile(projectId, askedYear);
  const data = profile.data;
  const notFound = profile.error instanceof ApiError && profile.error.status === 404;
  const state = useScreenState({ isLoading: profile.isLoading, error: notFound ? undefined : profile.error, data, isEmpty: () => false });
  const chosen = projects.data?.find((project) => project.id === projectId);

  const show = (event: FormEvent): void => {
    event.preventDefault();
    if (draftProject === '' || problem !== undefined) return;
    const next = new URLSearchParams();
    next.set('project', draftProject);
    if (draftYear.trim() !== '') next.set('plan_year', draftYear.trim());
    setParams(next);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ipf.page.title')}</h1>
          <p>{t('ipf.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('ipf.context.scope.label'), value: tenant?.name ?? '–' },
          { label: t('ipf.context.project.label'), value: chosen === undefined ? (projectId === undefined ? '–' : projectId.slice(0, 8)) : `${chosen.code} · ${chosen.name}` },
          { label: t('ipf.context.year.label'), value: data === undefined ? '–' : String(data.plan_year) },
        ]}
        {...(data === undefined ? {} : { asOf: dayText(data.as_of) })}
        stale={profile.isError && data !== undefined}
      />
      <form className="ipf-choose" onSubmit={show} noValidate aria-label={t('ipf.choose.aria')}>
        <div className="ent2-field">
          <label htmlFor="ipf-project">{t('ipf.choose.project.label')}</label>
          <select id="ipf-project" data-testid="project-select" value={draftProject} onChange={(event) => setDraftProject(event.target.value)}>
            <option value="">{t('ipf.choose.project.none')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="ent2-field" data-invalid={problem === undefined ? undefined : 'true'}>
          <label htmlFor="ipf-year">{t('ipf.choose.year.label')}</label>
          <input id="ipf-year" data-testid="year-input" inputMode="numeric" value={draftYear} aria-invalid={problem !== undefined} aria-describedby="ipf-year-note" onChange={(event) => setDraftYear(event.target.value)} />
          {problem === undefined ? (
            <span className="ent2-field__hint" id="ipf-year-note">
              {t('ipf.choose.year.hint')}
            </span>
          ) : (
            <span className="ent2-field__problem" role="alert" id="ipf-year-note" data-testid="year-problem">
              {problem === 'format' ? t('ipf.choose.year.format') : t('ipf.choose.year.range')}
            </span>
          )}
        </div>
        <button type="submit" className="ui-button ui-button--primary" data-testid="show-button" disabled={draftProject === '' || problem !== undefined}>
          {t('ipf.choose.show.action')}
        </button>
      </form>
      {projects.isError ? (
        <p className="callout warning" role="alert" data-testid="projects-failed">
          {t('ipf.choose.projects.failed')}
        </p>
      ) : null}
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('ipf.empty.noProject')}
        </p>
      ) : notFound ? (
        <p className="callout warning" role="alert" data-testid="project-not-found">
          {t('ipf.empty.notFound')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void profile.refetch()}>
          {data === undefined ? null : (
            <div className="ent2-page">
              <ClassificationSection profile={data} />
              <FindingsSection profile={data} />
              <MilestonesSection profile={data} />
              <LegalDocumentsSection profile={data} />
              <OriginSplitSection profile={data} />
            </div>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ipf.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
