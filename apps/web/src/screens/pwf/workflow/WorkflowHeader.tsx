import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { ContextBar, StatusPill } from '../../../ui';
import type { Tone } from '../../../ui';
import { templateKnown, templateName, versionText } from '../codes';
import { CalendarMissingNote, Meter, UnverifiedLabel } from '../components';
import { bandWord, remainingText } from '../labels';
import { dayText, rescheduleLink, stampText } from '../model';
import type { Schedule, WorkflowDetail } from '../model';
import { selectionModeWord } from '../process/labels';
import { attentionCount } from '../process/model';
import { BandDot, TierInfo } from '../task-cells';
import { WorkflowInfo } from './figures';
import { worstVariance } from './model';
import { openPhaseName, overallSlip, progressOf } from './step-table-model';

const STATUS_TONE: Readonly<Record<WorkflowDetail['status'], Tone>> = { ACTIVE: 'success', ON_HOLD: 'neutral', COMPLETED: 'info', CANCELLED: 'neutral' };
const STATUS_ICON: Readonly<Record<WorkflowDetail['status'], string>> = { ACTIVE: '●', ON_HOLD: '⏸', COMPLETED: '✓', CANCELLED: '⤼' };

function statusWord(t: ReturnType<typeof useTranslation>['t'], status: WorkflowDetail['status']): string {
  switch (status) {
    case 'ACTIVE':
      return t('pwf.flow.status.active.word');
    case 'ON_HOLD':
      return t('pwf.flow.status.onHold.word');
    case 'COMPLETED':
      return t('pwf.flow.status.completed.word');
    case 'CANCELLED':
      return t('pwf.flow.status.cancelled.word');
  }
}

interface Props {
  detail: WorkflowDetail;
  schedule: Schedule | undefined;
  years: readonly number[];
  stale: boolean;
  canReschedule: boolean;
}

/**
 * The head of the workflow of a project, above the step table: which phase is open, how far it is, the deadline of the whole file with how far it stands behind the baseline, and the count of tasks by official colour (the server's
 * counts); the state, the notices (template not confirmed, on hold, calendar missing, a choice against the rule, a ground that lapsed) and, one fold below, the frozen template and the figures of the schedule, each with its "i".
 */
export function WorkflowHeader({ detail, schedule, years, stale, canReschedule }: Props) {
  const { t } = useTranslation();
  const version = t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version });
  const phase = openPhaseName(detail);
  const progress = progressOf(detail);
  const overall = detail.overall_deadline ?? null;
  const slip = overallSlip(detail, schedule);
  const counts = detail.counts_by_band;
  const variance = schedule === undefined ? null : worstVariance(schedule);
  const critical = schedule?.critical_path.length ?? null;
  const finish = schedule?.project_finish ?? null;
  const taskNames = new Map(detail.tasks.map((task) => [task.task_code, task.name]));
  const template = templateKnown(detail.template_code) ? templateName(t, detail.template_code) : detail.template_code;
  const templateValue = t('pwf6.flow.template.text', { name: template, version: versionText(t, detail.template_rule_version) });
  const selection = detail.selection ?? null;
  const lapsed = attentionCount(detail);
  const asOf = schedule?.as_of ?? detail.as_of;
  return (
    <div data-testid="workflow-head">
      <ContextBar
        items={[
          { label: t('pwf.flow.fact.template.label'), value: templateValue },
          { label: t('pwf.flow.fact.start.label'), value: dayText(detail.planned_start_date) },
          { label: t('pwf.flow.fact.schedule.label'), value: String(detail.schedule_version) },
        ]}
        asOf={stampText(detail.as_of)}
        stale={stale}
      />
      <div className="pwfp-headline">
        <span className="pwf-pills">
          <span data-testid="workflow-status">
            <StatusPill tone={STATUS_TONE[detail.status]} icon={STATUS_ICON[detail.status]}>
              {statusWord(t, detail.status)}
            </StatusPill>
          </span>
          {detail.unverified ? (
            <span data-testid="unverified">
              <UnverifiedLabel />
            </span>
          ) : null}
        </span>
        {canReschedule ? (
          <Link className="ui-button ui-button--outline ui-button--small" to={rescheduleLink(detail.project_id)} data-testid="reschedule-link">
            {t('pwf.flow.reschedule.action')}
          </Link>
        ) : null}
      </div>
      <dl className="pwfp-kpis" data-testid="workflow-kpis">
        <div className="pwfp-kpi" data-testid="kpi-phase">
          <dt>{t('pwfp.head.phase.label')}</dt>
          <dd>{phase ?? <span className="pwf-hint">{t('pwfp.head.phase.none.text')}</span>}</dd>
        </div>
        <div className="pwfp-kpi" data-testid="kpi-progress">
          <dt>{t('pwfp.head.progress.label')}</dt>
          <dd>
            <span className="pwfp-kpi__value">{progress.of === 'steps' ? t('pwfp.head.progress.steps.text', { done: progress.done, total: progress.total }) : t('pwfp.head.progress.tasks.text', { done: progress.done, total: progress.total })}</span>
            <Meter done={progress.done} total={progress.total} label={t('pwfp.head.progress.label')} />
          </dd>
        </div>
        <div className="pwfp-kpi" data-testid="kpi-overall" data-band={overall?.band}>
          <dt>{t('pwfp.head.overall.label')}</dt>
          <dd>
            {overall === null ? (
              <span className="pwf-hint">{t('pwfp.head.overall.none.text')}</span>
            ) : (
              <>
                <span className="pwfp-kpi__value" data-testid="overall-due">
                  {dayText(overall.due_on)}
                </span>
                <span className="pwf-hint" data-testid="overall-name">
                  {overall.task_name}
                </span>
                {overall.band === 'NONE' ? null : (
                  <span className="pwfp-remaining" data-testid="overall-band" data-band={overall.band}>
                    <BandDot band={overall.band} />
                    <span className="pwfp-remaining__text">
                      <strong>{bandWord(t, overall.band)}</strong>
                      {overall.remaining_days === null ? null : <span className="pwf-hint">{remainingText(t, { band: overall.band, remaining_days: overall.remaining_days, unit: 'WORKING', overdue: overall.remaining_days < 0 })}</span>}
                    </span>
                    <TierInfo task={{ band_tier: overall.band_tier ?? undefined }} asOf={asOf} />
                  </span>
                )}
                {slip === null ? null : (
                  <span className={slip > 0 ? 'pwf-late' : 'pwf-hint'} data-testid="overall-slip">
                    {slip > 0 ? t('pwfp.head.overall.slip.text', { days: slip }) : t('pwfp.head.overall.onTime.text')}
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
        <div className="pwfp-kpi" data-testid="kpi-colours">
          <dt>
            {t('pwfp.head.colours.label')} <WorkflowInfo figure="bands" asOf={detail.as_of} version={version} />
          </dt>
          <dd>
            <span className="pwfp-counts" role="group" aria-label={t('pwf.flow.kpi.group.label')}>
              {(['RED', 'YELLOW', 'GREEN'] as const).map((band) => (
                <span key={band} className="pwfp-count" data-testid={`count-${band.toLowerCase()}`} data-band={band}>
                  <BandDot band={band} />
                  <strong>{counts[band]}</strong>
                  <span className="pwf-hint">{bandWord(t, band)}</span>
                </span>
              ))}
            </span>
            {counts.UNKNOWN > 0 ? (
              <span className="pwf-hint" data-testid="count-unknown">
                {t('pwfp.head.unknown.text', { count: counts.UNKNOWN })}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {detail.unverified ? <p className="callout warning pwf-notice">{t('pwf.flow.unverified.note')}</p> : null}
      {detail.status === 'ON_HOLD' ? <p className="callout pwf-notice">{t('pwf.flow.hold.note')}</p> : null}
      {selection !== null && selection.mode === 'OVERRIDE' ? (
        <p className="callout pwf-notice" role="status" data-testid="steps-override">
          {t('pwf.process.steps.override.text', { suggested: selection.suggested_template_code ?? '', reason: selection.reason ?? t('pwf.process.steps.override.noReason') })}
        </p>
      ) : null}
      {lapsed > 0 ? (
        <p className="callout warning pwf-notice" role="alert" data-testid="steps-lapsed">
          {t('pwf.process.steps.lapsed.text', { count: lapsed })}
        </p>
      ) : null}
      <CalendarMissingNote years={years} />
      <details className="pwf-fold pwfp-facts">
        <summary>{t('pwfp.head.facts.title')}</summary>
        <div className="pwf-fold__body">
          <dl className="pwf-stats" data-testid="workflow-facts">
            <div className="pwf-stats__item pwf-stats__item--wide">
              <dt>{t('pwf.flow.fact.template.label')}</dt>
              <dd>
                {templateValue}
                <span className="pwf-code" title={t('pwf.flow.fact.hash.label')}>
                  {detail.template_code} · {detail.template_hash.slice(0, 12)}
                </span>
                {selection === null ? null : <span className="pwf-hint">{t('pwf6.steps.selection.text', { mode: selectionModeWord(t, selection.mode), version: versionText(t, selection.rule_version) })}</span>}
              </dd>
            </div>
            <div className="pwf-stats__item">
              <dt>{t('pwf.flow.fact.start.label')}</dt>
              <dd>{dayText(detail.planned_start_date)}</dd>
            </div>
            <div className="pwf-stats__item">
              <dt>{t('pwf.flow.fact.finish.label')}</dt>
              <dd>
                <span className="pwf-figure" data-testid="project-finish">
                  {finish === null ? t('pwf.flow.finish.unknown.text') : dayText(finish)}
                  <WorkflowInfo figure="finish" asOf={asOf} version={version} />
                </span>
              </dd>
            </div>
            <div className="pwf-stats__item">
              <dt>{t('pwf.flow.fact.critical.label')}</dt>
              <dd>
                <span className="pwf-figure" data-testid="critical-count">
                  {critical === null ? t('pwf.flow.finish.unknown.text') : t('pwf.flow.kpi.tasks.text', { count: critical })}
                  <WorkflowInfo figure="critical" asOf={asOf} version={version} />
                </span>
              </dd>
            </div>
            <div className="pwf-stats__item" data-tone={variance !== null && variance.days > 0 ? 'danger' : undefined}>
              <dt>{t('pwf.flow.fact.variance.label')}</dt>
              <dd>
                <span className="pwf-figure" data-testid="variance">
                  {variance === null ? t('pwf.flow.finish.unknown.text') : variance.days <= 0 ? t('pwf6.flow.variance.none') : t('pwf6.flow.variance.text', { days: variance.days, task: taskNames.get(variance.task) ?? variance.task })}
                  <WorkflowInfo figure="variance" asOf={asOf} version={version} />
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </details>
    </div>
  );
}
