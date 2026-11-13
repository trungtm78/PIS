import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { dayText } from '../model';
import type { TaskDetail } from '../model';
import { LegalBasisList } from './LegalBasisList';
import { hasRevisionFacts } from './model';
import './process.css';

/**
 * Where a task stands in the procedure (R44, R45, R46): its step, the legal grounds of the step and of the task itself, and each form of the task with the revision in force today, the revision its evidence was made from and a warning
 * when the form was revised after the task made its document. Nothing is shown for an answer kept from before these facts existed.
 */
export function TaskProcessSection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const step = task.step ?? null;
  const own = task.legal_basis ?? [];
  const ofStep = task.step_legal_basis ?? [];
  const forms = task.form_templates.filter(hasRevisionFacts);
  if (task.step === undefined && task.legal_basis === undefined && forms.length === 0) return null;
  return (
    <>
      <SectionCard title={t('pwf.process.task.section.title')}>
        <div data-testid="task-process">
          {step === null ? (
            <p className="pwf-hint" data-testid="task-step-none">
              {t('pwf.process.task.noStep.text')}
            </p>
          ) : (
            <dl className="pwf-facts" data-testid="task-step">
              <dt>{t('pwf.process.task.step.label')}</dt>
              <dd>
                {step.order}. {step.name} <code>{step.code}</code>
              </dd>
              <dt>{t('pwf.process.task.phase.label')}</dt>
              <dd>
                <code>{step.phase_code}</code>
              </dd>
              {step.responsible_role === null ? null : (
                <>
                  <dt>{t('pwf.process.step.owner.label')}</dt>
                  <dd>
                    <code>{step.responsible_role}</code>
                  </dd>
                </>
              )}
            </dl>
          )}
          <h3>{t('pwf.process.task.ownLegal.title')}</h3>
          <LegalBasisList basis={own} of={task.name} testId="task-legal" />
          <h3>{t('pwf.process.task.stepLegal.title')}</h3>
          <LegalBasisList basis={ofStep} of={step?.name ?? task.name} testId="task-step-legal" />
        </div>
      </SectionCard>
      {forms.length === 0 ? null : (
        <SectionCard title={t('pwf.process.forms.section.title')}>
          <ul className="pwf-list" data-testid="task-forms">
            {forms.map((form) => (
              <li key={form.code} data-form-revision={form.code}>
                <strong>{form.current_title ?? form.code}</strong> <code>{form.code}</code>{' '}
                <StatusPill tone={form.policy === 'PINNED' ? 'info' : 'neutral'} icon={form.policy === 'PINNED' ? '◆' : '↻'}>
                  {form.policy === 'PINNED' ? t('pwf.process.forms.pinned.word', { revision: form.pinned_revision ?? 0 }) : t('pwf.process.forms.latest.word')}
                </StatusPill>
                <dl className="pwf-legal__facts">
                  <dt>{t('pwf.process.forms.current.label')}</dt>
                  <dd data-testid={`form-current-${form.code}`}>
                    {form.current_revision === null || form.current_revision === undefined
                      ? t('pwf.process.forms.current.none')
                      : t('pwf.process.forms.current.text', { revision: form.current_revision, from: dayText(form.current_effective_from) })}
                  </dd>
                  <dt>{t('pwf.process.forms.used.label')}</dt>
                  <dd data-testid={`form-used-${form.code}`}>
                    {form.used_revision === null || form.used_revision === undefined
                      ? form.satisfied
                        ? t('pwf.process.forms.used.unknown')
                        : t('pwf.process.forms.used.none')
                      : t('pwf.process.forms.used.text', { revision: form.used_revision, hash: (form.used_sha256 ?? '').slice(0, 12) })}
                  </dd>
                </dl>
                {form.newer_available === true ? (
                  <p className="callout warning pwf-notice" role="alert" data-testid={`form-newer-${form.code}`}>
                    {t('pwf.process.forms.newer.text', { used: form.used_revision ?? 0, current: form.current_revision ?? 0 })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </>
  );
}
