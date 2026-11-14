import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import type { TemplateValidation } from '../model';
import { templateFigures } from './template-model';
import type { Template } from './template-model';

export interface TemplateOutlineProps {
  template: Template;
  /** The problems the editor itself finds in the template as it is typed. */
  localProblems: number;
  /** The answer of the server to the last check, when it was made on the template as it stands now. */
  checked: TemplateValidation | undefined;
}

/**
 * PWF-02, the outline of the template above its tabs: what the template holds, part by part, in the words the screen catalogue names its fields with. The parts are edited in the tabs below (the links, the
 * branches, the documents and the checklist of a task show once a task is picked), so a person who opens a template reads here what is in it before opening any of them.
 */
export function TemplateOutline({ template, localProblems, checked }: TemplateOutlineProps) {
  const { t } = useTranslation();
  const figures = templateFigures(template);
  const errors = localProblems + (checked === undefined ? 0 : checked.findings.filter((finding) => finding.severity === 'ERROR').length);
  return (
    <SectionCard title={t('fix9.pwf02.outline.title')}>
      <dl className="pwf-tpl-outline" data-testid="outline">
        <div>
          <dt>{t('fix9.pwf02.dt.phases')}</dt>
          <dd data-testid="outline-phases">{t('fix9.pwf02.dd.phases', { phases: figures.phases, gates: figures.gates })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.tasks')}</dt>
          <dd data-testid="outline-tasks">{t('fix9.pwf02.dd.tasks', { tasks: figures.tasks, days: figures.workingDays, required: figures.required, responsible: figures.withResponsible, approver: figures.withApprover })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.links')}</dt>
          <dd data-testid="outline-links">{t('fix9.pwf02.dd.links', { fs: figures.links.FS, ss: figures.links.SS, ff: figures.links.FF, sf: figures.links.SF, lagged: figures.lagged })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.branches')}</dt>
          <dd data-testid="outline-branches">{t('fix9.pwf02.dd.branches', { count: figures.branched })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.documents')}</dt>
          <dd data-testid="outline-documents">{t('fix9.pwf02.dd.documents', { legal: figures.legalDocTypes, forms: figures.forms })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.checklist')}</dt>
          <dd data-testid="outline-checklist">{t('fix9.pwf02.dd.checklist', { count: figures.checklistItems })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.kpi')}</dt>
          <dd data-testid="outline-kpi">{t('fix9.pwf02.dd.kpi', { count: figures.withKpi })}</dd>
        </div>
        <div>
          <dt>{t('fix9.pwf02.dt.checks')}</dt>
          <dd data-testid="outline-checks">
            {checked === undefined ? t('fix9.pwf02.dd.unchecked', { errors }) : t('fix9.pwf02.dd.checked', { errors, hints: checked.quality_flags.length })}
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}
