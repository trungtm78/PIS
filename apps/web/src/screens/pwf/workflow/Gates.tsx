import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { missingReasonWord } from '../labels';
import type { WorkflowDetail } from '../model';
import { WorkflowInfo } from './figures';
import type { GateRow } from './model';
import { TaskLink } from './Views';

function GateItem({ row, projectId, names }: { row: GateRow; projectId: string; names: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  const assessment = row.assessment;
  const open = assessment === undefined ? row.missingCount === 0 : assessment.open;
  const gated = assessment?.gated ?? true;
  const count = assessment === undefined ? row.missingCount : assessment.missing.length;
  // The standing is the server's: a closed gate of a phase the project has not reached is NOT_DUE, said in neutral words and never as a failure. Only a gate that is CLOSED is red.
  const state = row.standing === 'NOT_DUE' ? 'upcoming' : row.standing === 'UNGATED' || !gated ? 'ungated' : open ? 'open' : 'waiting';
  return (
    <li className="pwf-gate" data-testid={`gate-${row.target}`} data-open={open} data-state={state} data-standing={row.standing}>
      <div className="pwf-gate__head">
        <strong>{row.word}</strong>
        {state === 'ungated' ? (
          <StatusPill tone="neutral" icon="○">
            {t('pwf.flow.gate.ungated.word')}
          </StatusPill>
        ) : state === 'open' ? (
          <StatusPill tone="success" icon="✓">
            {t('pwf.flow.gate.open.word')}
          </StatusPill>
        ) : state === 'upcoming' ? (
          <StatusPill tone="neutral" icon="○">
            {t('pwf.flow.gate.notDue.word')}
          </StatusPill>
        ) : (
          <StatusPill tone="danger" icon="⛔">
            {t('pwf.flow.gate.closed.word')}
          </StatusPill>
        )}
        {open ? null : <span className="sub">{t('pwf.flow.gate.summary.text', { count })}</span>}
      </div>
      {row.failed ? (
        <p className="callout warning" role="status">
          {t('pwf.flow.gate.failed.text')}
        </p>
      ) : null}
      {assessment === undefined || assessment.missing.length === 0 ? null : (
        <details open={state === 'waiting'}>
          <summary>{t('pwf6.gate.missing.summary', { count })}</summary>
          <ul aria-label={t('pwf.flow.gate.missing.label')}>
            {assessment.missing.map((item) => {
              const name = names.get(item.task) ?? item.task;
              return (
                <li key={`${item.task}:${item.reason}`}>
                  {item.task_id === null ? name : <TaskLink id={item.task_id} projectId={projectId}>{name}</TaskLink>}
                  {name === item.task ? null : <span className="pwf-code"> {item.task}</span>} · {missingReasonWord(t, item.reason)}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </li>
  );
}

/** The commands of the project the workflow stands guard over: whether each may run now and which required tasks, each with a link, still stand in the way. */
export function GatesPanel({ detail, rows }: { detail: WorkflowDetail; rows: readonly GateRow[] }) {
  const { t } = useTranslation();
  const names = new Map(detail.tasks.map((task) => [task.task_code, task.name]));
  return (
    <SectionCard title={t('pwf.flow.section.gates.title')} status={<WorkflowInfo figure="gate" asOf={detail.as_of} version={t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version })} />}>
      {rows.length === 0 ? (
        <p className="callout" role="status" data-testid="no-gates">
          {t('pwf.flow.gate.none.text')}
        </p>
      ) : (
        <ul className="pwf-gates">
          {rows.map((row) => (
            <GateItem key={row.target} row={row} projectId={detail.project_id} names={names} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
