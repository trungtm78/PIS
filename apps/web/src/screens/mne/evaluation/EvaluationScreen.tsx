import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../mne.css';
import { DecideDialog, PlanDialog, SubmitDialog } from './EvaluationDialogs';
import { useEvaluationProjects, useEvaluations } from './hooks';
import { conclusionLabel, evaluatorLabel, kindLabel, statusLabel } from './labels';
import { READ_PERMISSION, STATUSES, canPlan, holds } from './model';
import type { Evaluation } from './model';
import '../mne-kit.css';
import { StatusPill } from '../../../ui';
import { pillTone } from '../pill-tone';

const NONE = '—';

type Dialog = { kind: 'plan' } | { kind: 'submit' | 'decide'; evaluationId: string };

/**
 * MNE-08: the investment evaluation of a project (ST-MNE-009, MNE F9, BR-MNE-08, UAT-AC292, UAT-PLAN-74). An evaluation is planned for a kind that the stage of the project allows, submitted with its findings, a conclusion and the day it
 * was completed, and decided by somebody other than the person who planned it or submitted it; an approved evaluation is linked to the next overall report. The list shows each evaluation with its status, its conclusion and the buttons the
 * caller may press; the server judges every command again.
 */
export default function EvaluationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <EvaluationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EvaluationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('project') ?? '';
  const status = search.get('status') ?? '';
  const mayRead = holds(permissions, READ_PERMISSION);
  const mayPlan = canPlan(permissions, mode);
  const writable = mode !== 'READ_ONLY';
  const projects = useEvaluationProjects(mayRead);
  const list = useEvaluations(projectId, status, mayRead);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const lines = list.data ?? [];
  // A dialog on an evaluation names the evaluation, not a copy of it: it is read again from the table each time it is drawn, so that a retry sends the version the table shows now.
  const target = dialog === undefined || dialog.kind === 'plan' ? undefined : lines.find((line) => line.id === dialog.evaluationId);
  const filter = (name: 'project' | 'status', value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setSearch(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mne.evaluation.page.title')}</h1>
          <p>{t('mne.evaluation.page.subtitle')}</p>
        </div>
        {mayPlan ? (
          <div className="actions">
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog({ kind: 'plan' })}>
              {t('mne.evaluation.plan.action')}
            </button>
          </div>
        ) : null}
      </div>
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('mne.evaluation.read.denied')}
        </p>
      ) : (
        <>
          <div className="card">
            <div className="field">
              <label htmlFor="evaluation-filter-project">{t('mne.evaluation.field.project')}</label>
              <select id="evaluation-filter-project" value={projectId} onChange={(event) => filter('project', event.target.value)}>
                <option value="">{t('mne.evaluation.filter.all')}</option>
                {(projects.data ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {`${project.code} · ${project.name}`}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="evaluation-filter-status">{t('mne.evaluation.column.status')}</label>
              <select id="evaluation-filter-status" value={status} onChange={(event) => filter('status', event.target.value)}>
                <option value="">{t('mne.evaluation.filter.all')}</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {statusLabel(t, value)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <StateBoundary state={state} onRetry={() => void list.refetch()}>
            {lines.length === 0 ? (
              <p className="callout" role="status" data-testid="empty">
                {t('mne.evaluation.empty.notice')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table" aria-label={t('mne.evaluation.list.aria')} data-testid="evaluations">
                  <thead>
                    <tr>
                      <th scope="col">{t('mne.evaluation.column.project')}</th>
                      <th scope="col">{t('mne.evaluation.column.kind')}</th>
                      <th scope="col">{t('mne.evaluation.column.evaluator')}</th>
                      <th scope="col">{t('mne.evaluation.column.planned')}</th>
                      <th scope="col">{t('mne.evaluation.column.status')}</th>
                      <th scope="col">{t('mne.evaluation.column.conclusion')}</th>
                      <th scope="col">{t('mne.evaluation.column.completed')}</th>
                      <th scope="col">{t('mne.evaluation.column.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <EvaluationRow
                        key={line.id}
                        line={line}
                        writable={writable}
                        onSubmit={() => setDialog({ kind: 'submit', evaluationId: line.id })}
                        onDecide={() => setDialog({ kind: 'decide', evaluationId: line.id })}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </StateBoundary>
        </>
      )}
      {dialog?.kind === 'plan' && mayPlan ? <PlanDialog projects={projects.data ?? []} initialProject={projectId} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'submit' && target !== undefined && writable && target.mayChange ? <SubmitDialog key={target.id} evaluation={target} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'decide' && target !== undefined && writable && target.mayDecide ? <DecideDialog key={target.id} evaluation={target} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('mne.evaluation.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EvaluationRow({ line, writable, onSubmit, onDecide }: { line: Evaluation; writable: boolean; onSubmit(): void; onDecide(): void }) {
  const { t } = useTranslation();
  const aria = { project: line.projectCode, kind: kindLabel(t, line.kind) };
  return (
    <tr data-evaluation={line.id} data-status={line.status}>
      <td>
        <code>{line.projectCode}</code> {line.projectName}
      </td>
      <td>{kindLabel(t, line.kind)}</td>
      <td>
        {line.evaluatorName} <small className="sub">{evaluatorLabel(t, line.evaluatorKind)}</small>
      </td>
      <td>{line.plannedDate}</td>
      <td>
        <StatusPill tone={pillTone(line.status === 'APPROVED' ? 'green' : 'gray')}>{statusLabel(t, line.status)}</StatusPill>
        {line.status === 'APPROVED' && line.linkedReport ? (
          <small className="sub" data-testid="linked">
            {' '}
            {t('mne.evaluation.linked')}
          </small>
        ) : null}
        {line.status === 'RETURNED' && line.decisionReason !== null ? (
          <small className="sub" data-testid="return-reason">
            {' '}
            {line.decisionReason}
          </small>
        ) : null}
      </td>
      <td>{line.conclusion === null ? NONE : conclusionLabel(t, line.conclusion)}</td>
      <td>{line.completedDate ?? NONE}</td>
      <td>
        {writable && line.mayChange ? (
          <button type="button" aria-label={t('mne.evaluation.submit.aria', aria)} onClick={onSubmit}>
            {t('mne.evaluation.submit.action')}
          </button>
        ) : null}{' '}
        {writable && line.mayDecide ? (
          <button type="button" aria-label={t('mne.evaluation.decide.aria', aria)} onClick={onDecide}>
            {t('mne.evaluation.decide.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
