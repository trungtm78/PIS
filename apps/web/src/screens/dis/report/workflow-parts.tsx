import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard, Stepper } from '../../../ui';
import { formatMoment } from './decision-model';
import { useReportWorkflow } from './hooks';
import { showsSteps, stepperOf } from './workflow-model';
import type { WorkflowStep } from './workflow-model';

/**
 * The steps of the approval of a report (WF-1): each step with where the report is, its deadline and who it was given to, and for the people who decided it when. Shown for a tenant that runs the staged
 * approval; with the default definition the one decision of the reviewer stays as it was and nothing is added.
 */
export function WorkflowSteps({ reportId }: { reportId: string }) {
  const { t } = useTranslation();
  const query = useReportWorkflow(reportId);
  const workflow = query.data;
  if (workflow === undefined || !showsSteps(workflow)) return null;
  const now = new Date();
  const label = (step: WorkflowStep): string => step.name;
  return (
    <SectionCard title={t('dis.workflow.title')} status={t('dis.workflow.rule.text', { version: workflow.ruleVersion })}>
      <div data-testid="workflow-steps">
        <Stepper steps={stepperOf(workflow.steps, now, label)} label={t('dis.workflow.list.label')} />
        <ul className="dis-findings" data-testid="workflow-details">
          {workflow.steps.map((step) => (
            <li key={step.id} data-step={step.id} data-state={step.state}>
              <strong>{step.name}</strong>
              {step.state === 'AWAITING_RECEIPT' ? <span data-testid="step-awaiting-receipt"> {t('ent3c.workflow.awaitingReceipt.text')}</span> : null}
              {step.state === 'PUSH_FAILED' ? <span data-testid="step-push-failed"> {t('ent3c.workflow.pushFailed.text')}</span> : null}
              {step.receipt?.screen === 'HPM-01' ? (
                <span>
                  {' '}
                  <Link to="/hpm/hpm-01" data-testid="step-receipt-link">
                    {t('ent3c.workflow.receiptLink.link')}
                  </Link>
                </span>
              ) : null}
              {step.dueAt === null ? null : <span> {t('dis.workflow.due.text', { at: formatMoment(step.dueAt) })}</span>}
              {step.tasks.map((task) => {
                const name = task.assigneeName ?? t('dis.workflow.noname.text');
                return (
                  <div key={task.taskId} className="sub" data-task-status={task.status}>
                    {task.decidedAt === null ? t('dis.workflow.assignees.text', { names: name }) : t('dis.workflow.decided.text', { name, at: formatMoment(task.decidedAt) })}
                    {task.overdueReminders > 0 ? <span> {t('dis.workflow.reminders.text', { count: task.overdueReminders })}</span> : null}
                    {task.escalatedAt === null ? null : <span> {t('dis.workflow.escalated.text', { at: formatMoment(task.escalatedAt) })}</span>}
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}
