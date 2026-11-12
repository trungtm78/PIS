import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { ContextBar, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { Tone } from '../../../ui';
import { CalendarMissingNote, UnverifiedLabel } from '../components';
import { bandWord } from '../labels';
import { BANDS, bandIcon, bandTone, dayText, rescheduleLink, stampText } from '../model';
import type { Band, Schedule, WorkflowDetail } from '../model';
import { WorkflowInfo } from './figures';
import { worstVariance } from './model';

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

/** The head of the workflow: what template it was frozen from, its state and schedule version, the count of tasks by official colour and the figures of the schedule, each with its "i". */
export function Overview({ detail, schedule, years, stale, canReschedule }: Props) {
  const { t } = useTranslation();
  const scheduleVersion = t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version });
  const variance = schedule === undefined ? null : worstVariance(schedule);
  const critical = schedule?.critical_path.length ?? null;
  const finish = schedule?.project_finish ?? null;
  const tile = (band: Band) => (
    <KpiTile
      key={band}
      label={`${bandIcon(band)} ${bandWord(t, band)}`}
      value={String(detail.counts_by_band[band])}
      unit={t('pwf.flow.kpi.tasks.unit')}
      tone={bandTone(band)}
      sub={<WorkflowInfo figure="bands" asOf={detail.as_of} version={scheduleVersion} />}
    />
  );
  return (
    <>
      <ContextBar
        items={[
          { label: t('pwf.flow.fact.template.label'), value: t('pwf.flow.template.value.text', { code: detail.template_code, version: detail.template_rule_version }) },
          { label: t('pwf.flow.fact.start.label'), value: dayText(detail.planned_start_date) },
          { label: t('pwf.flow.fact.schedule.label'), value: String(detail.schedule_version) },
        ]}
        asOf={stampText(detail.as_of)}
        stale={stale}
      />
      <SectionCard
        title={t('pwf.flow.section.header.title')}
        status={
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
        }
        actions={
          canReschedule ? (
            <Link className="ui-button ui-button--outline ui-button--small" to={rescheduleLink(detail.project_id)} data-testid="reschedule-link">
              {t('pwf.flow.reschedule.action')}
            </Link>
          ) : undefined
        }
      >
        <dl className="pwf-facts" data-testid="workflow-facts">
          <dt>{t('pwf.flow.fact.template.label')}</dt>
          <dd>{t('pwf.flow.template.value.text', { code: detail.template_code, version: detail.template_rule_version })}</dd>
          <dt>{t('pwf.flow.fact.hash.label')}</dt>
          <dd>
            <code>{detail.template_hash.slice(0, 12)}</code>
          </dd>
          <dt>{t('pwf.flow.fact.start.label')}</dt>
          <dd>{dayText(detail.planned_start_date)}</dd>
          <dt>{t('pwf.flow.fact.finish.label')}</dt>
          <dd>
            <span className="pwf-figure" data-testid="project-finish">
              {finish === null ? t('pwf.flow.finish.unknown.text') : dayText(finish)}
              <WorkflowInfo figure="finish" asOf={schedule?.as_of ?? detail.as_of} version={scheduleVersion} />
            </span>
          </dd>
          <dt>{t('pwf.flow.fact.critical.label')}</dt>
          <dd>
            <span className="pwf-figure" data-testid="critical-count">
              {critical === null ? t('pwf.flow.finish.unknown.text') : t('pwf.flow.kpi.tasks.text', { count: critical })}
              <WorkflowInfo figure="critical" asOf={schedule?.as_of ?? detail.as_of} version={scheduleVersion} />
            </span>
          </dd>
          <dt>{t('pwf.flow.fact.variance.label')}</dt>
          <dd>
            <span className="pwf-figure" data-testid="variance">
              {variance === null ? t('pwf.flow.finish.unknown.text') : t('pwf.flow.variance.value.text', { days: variance.days, task: variance.task })}
              <WorkflowInfo figure="variance" asOf={schedule?.as_of ?? detail.as_of} version={scheduleVersion} />
            </span>
          </dd>
        </dl>
        {detail.unverified ? <p className="callout warning pwf-notice">{t('pwf.flow.unverified.note')}</p> : null}
        {detail.status === 'ON_HOLD' ? <p className="callout pwf-notice">{t('pwf.flow.hold.note')}</p> : null}
        <CalendarMissingNote years={years} />
      </SectionCard>
      <KpiStrip label={t('pwf.flow.kpi.group.label')}>{BANDS.map(tile)}</KpiStrip>
    </>
  );
}
