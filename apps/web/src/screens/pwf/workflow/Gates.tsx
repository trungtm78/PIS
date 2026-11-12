import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { missingReasonWord } from '../labels';
import type { WorkflowDetail } from '../model';
import { WorkflowInfo } from './figures';
import type { GateRow } from './model';
import { TaskLink } from './Views';

function GateItem({ row, projectId }: { row: GateRow; projectId: string }) {
  const { t } = useTranslation();
  const assessment = row.assessment;
  const open = assessment === undefined ? row.missingCount === 0 : assessment.open;
  const gated = assessment?.gated ?? true;
  return (
    <li className="pwf-gate" data-testid={`gate-${row.target}`} data-open={open}>
      <strong>{row.word}</strong>{' '}
      {!gated ? (
        <StatusPill tone="neutral" icon="○">
          {t('pwf.flow.gate.ungated.word')}
        </StatusPill>
      ) : open ? (
        <StatusPill tone="success" icon="✓">
          {t('pwf.flow.gate.open.word')}
        </StatusPill>
      ) : (
        <StatusPill tone="danger" icon="⛔">
          {t('pwf.flow.gate.closed.word')}
        </StatusPill>
      )}
      {open ? null : <span className="sub"> {t('pwf.flow.gate.summary.text', { count: assessment === undefined ? row.missingCount : assessment.missing.length })}</span>}
      {row.failed ? (
        <p className="callout warning" role="status">
          {t('pwf.flow.gate.failed.text')}
        </p>
      ) : null}
      {assessment === undefined || assessment.missing.length === 0 ? null : (
        <ul aria-label={t('pwf.flow.gate.missing.label')}>
          {assessment.missing.map((item) => (
            <li key={`${item.task}:${item.reason}`}>
              {item.task_id === null ? item.task : <TaskLink id={item.task_id} projectId={projectId}>{item.task}</TaskLink>} · {missingReasonWord(t, item.reason)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The commands of the project the workflow stands guard over: whether each may run now and which required tasks, each with a link, still stand in the way. */
export function GatesPanel({ detail, rows }: { detail: WorkflowDetail; rows: readonly GateRow[] }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('pwf.flow.section.gates.title')} status={<WorkflowInfo figure="gate" asOf={detail.as_of} version={t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version })} />}>
      {rows.length === 0 ? (
        <p className="callout" role="status" data-testid="no-gates">
          {t('pwf.flow.gate.none.text')}
        </p>
      ) : (
        <ul className="pwf-gates">
          {rows.map((row) => (
            <GateItem key={row.target} row={row} projectId={detail.project_id} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
