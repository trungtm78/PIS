import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AuditLine, KpiStrip, KpiTile, SectionCard, StatusPill, StickyActions } from '../../ui';
import { DECISION_PATH, PROPOSAL_PATH, SCORE_PATH, appraisalLink } from './appraisal-model';
import { BackLink, NationalCode, ProjectFormFields, SuggestionPanel, optionsWith } from './components';
import { useMasterOptions, useProject, useUnits, useUpdateProfile } from './hooks';
import { classificationLabel, lifeLabel, problemMessage, stageLabel, stageTone } from './labels';
import {
  AREA_TYPES,
  LIST_PATH,
  PROGRAM_TYPES,
  PROJECT_TYPE_TYPES,
  SECTOR_TYPES,
  UPDATE_PERMISSION,
  amountText,
  describeProblem,
  formOf,
  isDossierLocked,
  isFrozen,
  profileBody,
  readAtLabel,
  validateForm,
} from './model';
import type { ProjectField, ProjectForm, ProjectView } from './model';
import './prj.css';

const NEVER_EMPTY = (): boolean => false;

type Tab = 'overview' | 'objectives' | 'plan' | 'disbursement' | 'issues';
const TABS: readonly Tab[] = ['overview', 'objectives', 'plan', 'disbursement', 'issues'];

function tabLabel(t: ReturnType<typeof useTranslation>['t'], tab: Tab): string {
  switch (tab) {
    case 'overview':
      return t('prj.workspace.tab.overview');
    case 'objectives':
      return t('prj.workspace.tab.objectives');
    case 'plan':
      return t('prj.workspace.tab.plan');
    case 'disbursement':
      return t('prj.workspace.tab.disbursement');
    case 'issues':
      return t('prj.workspace.tab.issues');
  }
}

function tabNotice(t: ReturnType<typeof useTranslation>['t'], tab: Exclude<Tab, 'overview'>): string {
  switch (tab) {
    case 'objectives':
      return t('prj.workspace.objectives.notice');
    case 'plan':
      return t('prj.workspace.plan.notice');
    case 'disbursement':
      return t('prj.workspace.disbursement.notice');
    case 'issues':
      return t('prj.workspace.issues.notice');
  }
}

/** PRJ-03: the workspace of one project, a shell whose tabs fill with the plan, the disbursement and the issues of the project as those modules land. */
export default function ProjectWorkspaceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ProjectWorkspaceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProjectWorkspaceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const projectId = params.get('id') ?? undefined;
  const project = useProject(projectId);
  const [tab, setTab] = useState<Tab>('overview');
  const state = useScreenState({
    isLoading: project.isLoading,
    error: project.error,
    data: projectId === undefined ? undefined : (project.data ?? undefined),
    isEmpty: NEVER_EMPTY,
  });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('prj.back.list.link')}</BackLink>
      {projectId === undefined || (project.isSuccess && project.data === null) ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('prj.workspace.page.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-project">
            {t('prj.workspace.noProject.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void project.refetch()}>
          {project.data === undefined || project.data === null ? null : <Workspace project={project.data} tab={tab} onTab={setTab} onReload={() => void project.refetch()} />}
        </StateBoundary>
      )}
      <p className="prototype-note">
        {t('prj.workspace.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}

function Workspace({ project, tab, onTab, onReload }: { project: ProjectView; tab: Tab; onTab: (tab: Tab) => void; onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">
            {project.code} · {project.name}
          </h1>
          <p>
            <span data-testid="stage">
              <StatusPill tone={stageTone(project.status)}>{stageLabel(t, project.status)}</StatusPill>
            </span>{' '}
            <NationalCode code={project.nationalProjectCode} />
          </p>
          {project.status === 'CONCEPT' ? (
            <p data-testid="appraisal-links">
              <Link to={appraisalLink(PROPOSAL_PATH, project.id)}>{t('prj.workspace.appraisal.propose.link')}</Link>
            </p>
          ) : project.status === 'APPRAISAL' ? (
            <p data-testid="appraisal-links">
              <Link to={appraisalLink(SCORE_PATH, project.id)}>{t('prj.workspace.appraisal.score.link')}</Link> ·{' '}
              <Link to={appraisalLink(DECISION_PATH, project.id)}>{t('prj.workspace.appraisal.decide.link')}</Link>
            </p>
          ) : null}
        </div>
      </div>
      <div className="prj-tabs" role="tablist" aria-label={t('prj.workspace.tabs.title')}>
        {TABS.map((item) => (
          <button key={item} type="button" role="tab" id={`tab-${item}`} aria-selected={tab === item} aria-controls={`panel-${item}`} onClick={() => onTab(item)}>
            {tabLabel(t, item)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'overview' ? (
          <Overview project={project} onReload={onReload} />
        ) : (
          <p className="callout" role="status" data-testid="tab-notice">
            {tabNotice(t, tab)}
          </p>
        )}
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Overview({ project, onReload }: { project: ProjectView; onReload: () => void }) {
  const { t, locale } = useTranslation();
  const none = t('prj.workspace.value.none');
  const years = project.startYear === null && project.endYear === null ? none : `${project.startYear ?? ''} – ${project.endYear ?? ''}`;
  return (
    <>
      <KpiStrip label={t('prj.workspace.kpi.label')}>
        <KpiTile label={t('prj.workspace.field.total')} value={amountText(project.totalInvestmentVnd, locale)} unit={t('prj.workspace.kpi.unit')} tone="info" />
        <KpiTile label={t('prj.workspace.field.years')} value={years} />
        <KpiTile label={t('prj.workspace.field.score')} value={project.appraisalScore ?? t('prj.workspace.kpi.noScore')} />
      </KpiStrip>
      <div className="prj-grid">
        <SectionCard title={t('prj.workspace.profile.title')}>
          <dl className="prj-facts" data-testid="profile">
            <Fact label={t('prj.workspace.field.code')}>
              <code>{project.code}</code>
            </Fact>
            <Fact label={t('prj.workspace.field.name')}>{project.name}</Fact>
            <Fact label={t('prj.workspace.field.owner')}>{project.ownerUnitName}</Fact>
            <Fact label={t('prj.workspace.field.investor')}>{project.investorUnitName ?? none}</Fact>
            <Fact label={t('prj.workspace.field.authority')}>{project.decisionAuthorityUnitName ?? none}</Fact>
            <Fact label={t('prj.workspace.field.area')}>{project.area.label}</Fact>
            <Fact label={t('prj.workspace.field.sector')}>{project.sector?.label ?? none}</Fact>
            <Fact label={t('prj.workspace.field.projectType')}>{project.projectType?.label ?? none}</Fact>
            <Fact label={t('prj.workspace.field.program')}>{project.program?.label ?? none}</Fact>
            <Fact label={t('prj.workspace.field.total')}>
              {t('prj.workspace.value.amount', {
                amount: amountText(project.totalInvestmentVnd, locale),
              })}
            </Fact>
            <Fact label={t('prj.workspace.field.years')}>{years}</Fact>
            <Fact label={t('prj.workspace.field.classification')}>{classificationLabel(t, project.classification)}</Fact>
            <Fact label={t('prj.workspace.field.stage')}>
              {stageLabel(t, project.status)} · {lifeLabel(t, project.status)}
            </Fact>
            <Fact label={t('prj.workspace.field.group')}>{project.projectGroup ?? none}</Fact>
            <Fact label={t('prj.workspace.field.score')}>{project.appraisalScore ?? none}</Fact>
            <Fact label={t('prj.workspace.field.leader')}>{project.leaderName ?? none}</Fact>
          </dl>
          <h3>{t('prj.workspace.suggestion.title')}</h3>
          <SuggestionPanel suggestion={project.suggestion} />
        </SectionCard>
        <ProfileEditor project={project} onReload={onReload} />
      </div>
      <AuditLine
        items={[
          {
            label: t('prj.workspace.audit.created'),
            value: readAtLabel(Date.parse(project.createdAt)),
          },
          {
            label: t('prj.workspace.audit.changed'),
            value: readAtLabel(Date.parse(project.statusChangedAt)),
          },
          {
            label: t('prj.workspace.audit.version'),
            value: String(project.version),
          },
        ]}
      />
    </>
  );
}

function ProfileEditor({ project, onReload }: { project: ProjectView; onReload: () => void }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canUpdate = (permissions === undefined || permissions.includes(UPDATE_PERMISSION)) && mode !== 'READ_ONLY' && !isFrozen(project.status);
  const units = useUnits(canUpdate);
  const areas = useMasterOptions(AREA_TYPES, canUpdate);
  const sectors = useMasterOptions(SECTOR_TYPES, canUpdate);
  const projectTypes = useMasterOptions(PROJECT_TYPE_TYPES, canUpdate);
  const programs = useMasterOptions(PROGRAM_TYPES, canUpdate);
  const update = useUpdateProfile();
  const [form, setForm] = useState<ProjectForm>(() => formOf(project));
  const [errors, setErrors] = useState<Partial<Record<ProjectField, ReturnType<typeof validateForm>[ProjectField]>>>({});
  const [saved, setSaved] = useState(false);
  const problem = update.isError ? describeProblem(update.error) : undefined;
  // A new version of the project (a save, a reload after a conflict) starts the form over from what is stored.
  useEffect(() => {
    setForm(formOf(project));
    setErrors({});
  }, [project]);
  const area = useMemo(() => optionsWith(areas.data ?? [], project.area, 'AREA'), [areas.data, project.area]);
  const sector = useMemo(() => optionsWith(sectors.data ?? [], project.sector, 'SECTOR'), [sectors.data, project.sector]);
  const projectType = useMemo(() => optionsWith(projectTypes.data ?? [], project.projectType, 'PROJECT_TYPE'), [projectTypes.data, project.projectType]);
  const program = useMemo(() => optionsWith(programs.data ?? [], project.program, 'PROGRAM'), [programs.data, project.program]);

  const setField = (field: ProjectField, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaved(false);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (update.isPending || !canUpdate) return;
    const found = validateForm(form, 'profile');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = profileBody(project, form);
    if (Object.keys(body).length === 0) return;
    update.mutate({ id: project.id, version: project.version, body }, { onSuccess: () => setSaved(true) });
  };

  return (
    <form onSubmit={save} noValidate aria-label={t('prj.workspace.edit.title')}>
      <SectionCard title={t('prj.workspace.edit.title')}>
        {!canUpdate ? (
          <p className="callout" role="status" data-testid="read-only">
            {isFrozen(project.status) ? t('prj.workspace.edit.frozen.notice') : t('prj.workspace.edit.denied.notice')}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="problem">
            {problemMessage(t, problem)}
          </p>
        )}
        {problem?.reason === 'versionConflict' ? (
          <p>
            <button
              type="button"
              className="ui-button ui-button--outline"
              onClick={() => {
                update.reset();
                onReload();
              }}
            >
              {t('prj.workspace.edit.reload.action')}
            </button>
          </p>
        ) : null}
        {saved ? (
          <p role="status" data-testid="saved">
            {t('prj.workspace.edit.saved.notice')}
          </p>
        ) : null}
        <ProjectFormFields
          mode="profile"
          form={form}
          errors={errors}
          onChange={setField}
          units={units.data ?? []}
          areas={area}
          sectors={sector}
          projectTypes={projectType}
          programs={program}
          disabled={!canUpdate}
          dossierLocked={isDossierLocked(project.status)}
        />
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={!canUpdate || update.isPending}>
              {update.isPending ? t('prj.workspace.edit.submit.pending') : t('prj.workspace.edit.submit.action')}
            </button>
          }
        />
      </SectionCard>
    </form>
  );
}
