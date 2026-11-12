import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { useEffectiveness } from '../../mne/effect/hooks';
import { bandText, bandTone, directionText } from '../../mne/effect/labels';
import type { TargetSet } from '../../mne/effect/model';
import { recommendationLabel } from '../appraisal-labels';
import { DECISION_PATH, PROPOSAL_PATH, SCORE_PATH, appraisalLink } from '../appraisal-model';
import type { AppraisalView, Criterion } from '../appraisal-model';
import { classificationLabel, stageLabel } from '../labels';
import { amountText } from '../model';
import type { ProjectView } from '../model';
import { useRevisions } from '../revision/hooks';
import { dossierOf } from '../revision/model';
import { documentText, statusLabel as revisionStatusLabel } from '../revision/shared';
import { QuerySection } from './common';
import type { TabProps } from './common';
import { decisionStep, proposalStep, useLifecycleBlock } from './obj-hooks';
import type { LifecycleBlock, StageStep } from './obj-hooks';

const EFFECT_PATH = '/mne/mne-11';
const DOSSIER_PATH = '/prj/prj-04';
const REVISION_PATH = '/prj/prj-06';

const dayOf = (value: string | null): string => (value === null ? '' : value.slice(0, 10));

/** PRJ-03, tab "Objectives": scope and basis of the investment, target indicators, proposal, appraisal and the legal dossier of the project. */
export default function ObjectivesTab({ project }: TabProps) {
  return (
    <div data-testid="tab-objectives">
      <ScopeCard project={project} />
      <TargetsSection project={project} />
      <ProposalSection project={project} />
      <AppraisalSection project={project} />
      <DossierSection project={project} />
    </div>
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

/** The scope the project record holds: kind, sector, programme, area, size, period and the group the rules suggest. The record carries no free-text purpose, so none is shown. */
function ScopeCard({ project }: { project: ProjectView }) {
  const { t, locale } = useTranslation();
  const none = t('prj.workspace.value.none');
  const period = project.startYear === null && project.endYear === null ? none : `${project.startYear ?? ''} – ${project.endYear ?? ''}`;
  return (
    <SectionCard title={t('prj.wsTab.obj.scope.title')}>
      <div data-testid="obj-scope">
        <dl className="prj-facts">
          <Fact label={t('prj.workspace.field.projectType')}>{project.projectType?.label ?? none}</Fact>
          <Fact label={t('prj.workspace.field.sector')}>{project.sector?.label ?? none}</Fact>
          <Fact label={t('prj.workspace.field.program')}>{project.program?.label ?? none}</Fact>
          <Fact label={t('prj.workspace.field.area')}>{project.area.label}</Fact>
          <Fact label={t('prj.workspace.field.total')}>{t('prj.workspace.value.amount', { amount: amountText(project.totalInvestmentVnd, locale) })}</Fact>
          <Fact label={t('prj.workspace.field.years')}>{period}</Fact>
          <Fact label={t('prj.workspace.field.classification')}>{classificationLabel(t, project.classification)}</Fact>
          <Fact label={t('prj.workspace.field.group')}>{project.projectGroup ?? none}</Fact>
        </dl>
        {project.suggestion === null ? (
          <p className="callout" role="status">
            {t('prj.wsTab.obj.scope.noSuggestion')}
          </p>
        ) : (
          <p data-testid="obj-basis">
            {t('prj.wsTab.obj.scope.basis', { group: project.suggestion.groupKey, basis: project.suggestion.legalBasis === '' ? none : project.suggestion.legalBasis })}
            {project.suggestion.awaitingConfirmation ? ` ${t('prj.wsTab.obj.awaiting.note')}` : ''}
          </p>
        )}
      </div>
    </SectionCard>
  );
}

function TargetsSection({ project }: { project: ProjectView }) {
  const { t } = useTranslation();
  const query = useEffectiveness(project.id);
  const set: TargetSet | null | undefined = query.isSuccess ? (query.data?.fixed ?? query.data?.draft ?? null) : undefined;
  return (
    <QuerySection<TargetSet | null>
      title={t('prj.wsTab.obj.targets.title')}
      query={{ isLoading: query.isLoading, error: query.error, data: set, refetch: query.refetch }}
      isEmpty={(value) => value === null || value.indicators.length === 0}
      emptyText={t('prj.wsTab.obj.targets.empty')}
      linkTo={`${EFFECT_PATH}?id=${project.id}`}
      linkLabel={t('prj.wsTab.obj.targets.link')}
      testId="obj-targets"
    >
      {(value) => (value === null ? null : <TargetTable set={value} />)}
    </QuerySection>
  );
}

function TargetTable({ set }: { set: TargetSet }) {
  const { t } = useTranslation();
  return (
    <>
      <p>
        <StatusPill tone={set.status === 'FIXED' ? 'success' : 'warning'}>{set.status === 'FIXED' ? t('prj.wsTab.obj.targets.fixed') : t('prj.wsTab.obj.targets.draft')}</StatusPill> {set.basis}
      </p>
      <div className="tablewrap">
        <table className="table" aria-label={t('prj.wsTab.obj.targets.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('prj.wsTab.obj.targets.colIndicator')}</th>
              <th scope="col">{t('prj.wsTab.obj.targets.colBaseline')}</th>
              <th scope="col">{t('prj.wsTab.obj.targets.colTarget')}</th>
              <th scope="col">{t('prj.wsTab.obj.targets.colActual')}</th>
              <th scope="col">{t('prj.wsTab.obj.targets.colBand')}</th>
            </tr>
          </thead>
          <tbody>
            {set.indicators.map((indicator) => (
              <tr key={indicator.id}>
                <td>
                  {indicator.name} <span className="prj-code">{directionText(t, indicator.direction)}</span>
                </td>
                <td>{indicator.baselineValue === null ? '–' : `${indicator.baselineValue} ${indicator.unit}`}</td>
                <td>{`${indicator.targetValue} ${indicator.unit}`}</td>
                <td>{indicator.actual === null ? '–' : `${indicator.actual.value} ${indicator.unit}`}</td>
                <td>
                  <StatusPill tone={bandTone(indicator.variance.band)}>{bandText(t, indicator.variance.band)}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProposalSection({ project }: { project: ProjectView }) {
  const { t } = useTranslation();
  const query = useLifecycleBlock(project.id);
  return (
    <QuerySection<LifecycleBlock>
      title={t('prj.wsTab.obj.proposal.title')}
      query={query}
      isEmpty={(block) => proposalStep(block.history) === undefined && project.status === 'CONCEPT'}
      emptyText={t('prj.wsTab.obj.proposal.empty')}
      linkTo={appraisalLink(PROPOSAL_PATH, project.id)}
      linkLabel={t('prj.wsTab.obj.proposal.link')}
      testId="obj-proposal"
    >
      {(block) => <ProposalFacts project={project} block={block} />}
    </QuerySection>
  );
}

function ProposalFacts({ project, block }: { project: ProjectView; block: LifecycleBlock }) {
  const { t } = useTranslation();
  const none = t('prj.workspace.value.none');
  const step = proposalStep(block.history);
  const proposedOn = project.proposedOn === '' ? dayOf(step?.occurredAt ?? null) : project.proposedOn;
  return (
    <dl className="prj-facts">
      <Fact label={t('prj.wsTab.obj.proposal.on')}>{proposedOn === '' ? none : proposedOn}</Fact>
      <Fact label={t('prj.wsTab.obj.proposal.by')}>{step?.actorName ?? none}</Fact>
      <Fact label={t('prj.wsTab.obj.proposal.round')}>{block.appraisal?.round ?? none}</Fact>
      <Fact label={t('prj.wsTab.obj.proposal.reason')}>{step?.reason ?? none}</Fact>
      <Fact label={t('prj.wsTab.obj.proposal.stage')}>{stageLabel(t, project.status)}</Fact>
    </dl>
  );
}

function AppraisalSection({ project }: { project: ProjectView }) {
  const { t } = useTranslation();
  const query = useLifecycleBlock(project.id);
  return (
    <QuerySection<LifecycleBlock>
      title={t('prj.wsTab.obj.appraisal.title')}
      query={query}
      isEmpty={(block) => block.appraisal === null || (block.appraisal.criteriaSet === null && project.appraisalScore === null)}
      emptyText={t('prj.wsTab.obj.appraisal.empty')}
      linkTo={appraisalLink(project.status === 'APPRAISAL' ? DECISION_PATH : SCORE_PATH, project.id)}
      linkLabel={t('prj.wsTab.obj.appraisal.link')}
      testId="obj-appraisal"
    >
      {(block) => (block.appraisal === null ? null : <AppraisalBody project={project} appraisal={block.appraisal} decision={decisionStep(block.history)} />)}
    </QuerySection>
  );
}

/** The mean of one criterion over the sheets that scored it, one decimal; null when no sheet carries it. */
function meanScore(appraisal: AppraisalView, criterion: Criterion): string | null {
  const scores = appraisal.sheets.flatMap((sheet) => sheet.scores.filter((score) => score.criterionCode === criterion.code).map((score) => score.score));
  return scores.length === 0 ? null : (scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1);
}

function AppraisalBody({ project, appraisal, decision }: { project: ProjectView; appraisal: AppraisalView; decision: StageStep | undefined }) {
  const { t } = useTranslation();
  const none = t('prj.workspace.value.none');
  const set = appraisal.criteriaSet;
  const scored = appraisal.sheets.length > 0;
  const outcome = decision === undefined ? null : decision.to === 'REJECTED' ? 'REJECT' : decision.to === 'CONCEPT' ? 'RETURN' : 'ADMIT';
  return (
    <>
      <dl className="prj-facts">
        <Fact label={t('prj.wsTab.obj.appraisal.score')}>{project.appraisalScore === null ? none : t('prj.wsTab.obj.appraisal.scoreOf', { score: project.appraisalScore, threshold: set?.passThreshold ?? none })}</Fact>
        <Fact label={t('prj.wsTab.obj.appraisal.sheets')}>{appraisal.summary?.sheetCount ?? appraisal.sheets.length}</Fact>
        <Fact label={t('prj.wsTab.obj.appraisal.decision')}>
          {decision === undefined ? t('prj.wsTab.obj.appraisal.undecided') : `${outcome === null ? none : recommendationLabel(t, outcome)} · ${dayOf(decision.occurredAt)} · ${decision.actorName ?? none}`}
        </Fact>
        {decision?.reason == null ? null : <Fact label={t('prj.wsTab.obj.appraisal.decisionReason')}>{decision.reason}</Fact>}
        {decision === undefined ? null : <Fact label={t('prj.wsTab.obj.appraisal.document')}>{decision.hasDecisionDocument ? t('prj.wsTab.obj.appraisal.documentYes') : t('prj.wsTab.obj.appraisal.documentNo')}</Fact>}
      </dl>
      {set === null ? null : (
        <>
          <p>
            {t('prj.wsTab.obj.appraisal.set', { key: set.key, revision: set.revision, threshold: set.passThreshold })}
            {set.awaitingConfirmation ? ` ${t('prj.wsTab.obj.awaiting.note')}` : ''}
          </p>
          <div className="tablewrap">
            <table className="table" aria-label={t('prj.wsTab.obj.appraisal.aria')}>
              <thead>
                <tr>
                  <th scope="col">{t('prj.wsTab.obj.appraisal.colCriterion')}</th>
                  <th scope="col">{t('prj.wsTab.obj.appraisal.colWeight')}</th>
                  {scored ? <th scope="col">{t('prj.wsTab.obj.appraisal.colMean')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {set.criteria.map((criterion) => (
                  <tr key={criterion.code}>
                    <td>{criterion.name}</td>
                    <td>{criterion.weight}</td>
                    {scored ? <td>{meanScore(appraisal, criterion) ?? none}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function DossierSection({ project }: { project: ProjectView }) {
  const { t } = useTranslation();
  const query = useRevisions(project.id);
  return (
    <QuerySection
      title={t('prj.wsTab.obj.dossier.title')}
      query={{ isLoading: query.isLoading, error: query.error, data: query.data === undefined ? undefined : dossierOf(query.data.items), refetch: query.refetch }}
      isEmpty={(items) => items.length === 0}
      emptyText={t('prj.wsTab.obj.dossier.empty')}
      linkTo={`${DOSSIER_PATH}?id=${project.id}`}
      linkLabel={t('prj.wsTab.obj.dossier.link')}
      testId="obj-dossier"
    >
      {(items) => (
        <>
          <div className="tablewrap">
            <table className="table" aria-label={t('prj.wsTab.obj.dossier.aria')}>
              <thead>
                <tr>
                  <th scope="col">{t('prj.dossier.col.number')}</th>
                  <th scope="col">{t('prj.dossier.col.effective')}</th>
                  <th scope="col">{t('prj.dossier.col.revision')}</th>
                  <th scope="col">{t('prj.dossier.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.document === null ? '—' : documentText(t, item.document)}</td>
                    <td>{item.effectiveFrom ?? '—'}</td>
                    <td>{t('prj.revision.row.number', { revision: item.revision })}</td>
                    <td>{revisionStatusLabel(t, item.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="prj-links">
            <Link to={`${REVISION_PATH}?id=${project.id}`}>{t('prj.dossier.revisions.link')}</Link>
          </p>
        </>
      )}
    </QuerySection>
  );
}
