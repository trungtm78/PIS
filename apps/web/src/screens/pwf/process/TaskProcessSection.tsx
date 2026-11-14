import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { dayText } from '../model';
import type { TaskDetail } from '../model';
import { LegalBasisList } from './LegalBasisList';
import { hasRevisionFacts } from './model';
import type { LegalBasis, TaskForm } from './model';
import './process.css';

export interface MergedBasis {
  basis: LegalBasis;
  /** Cited by the task itself, by its step, or by both. */
  from: 'task' | 'step' | 'both';
}

/** The legal grounds of the task and of its step as one list: a document cited by both with the same article is said once. */
export function mergedBasis(own: readonly LegalBasis[], ofStep: readonly LegalBasis[]): MergedBasis[] {
  const key = (one: LegalBasis): string => `${one.document_code}|${one.article ?? ''}`;
  const merged = new Map<string, MergedBasis>();
  for (const basis of own) merged.set(key(basis), { basis, from: 'task' });
  for (const basis of ofStep) {
    const found = merged.get(key(basis));
    if (found === undefined) merged.set(key(basis), { basis, from: 'step' });
    else found.from = 'both';
  }
  return [...merged.values()];
}

/** The revision of one form of the task: the one in force today, the one its evidence was made from, and a warning when the form was revised after the task made its document. */
export function FormRevision({ form }: { form: TaskForm }) {
  const { t } = useTranslation();
  if (!hasRevisionFacts(form)) return null;
  return (
    <div className="pwf-docs__revision" data-form-revision={form.code}>
      <StatusPill tone={form.policy === 'PINNED' ? 'info' : 'neutral'} icon={form.policy === 'PINNED' ? '◆' : '↻'}>
        {form.policy === 'PINNED' ? t('pwf.process.forms.pinned.word', { revision: form.pinned_revision ?? 0 }) : t('pwf.process.forms.latest.word')}
      </StatusPill>
      <dl className="pwf-legal__facts">
        <dt>{t('pwf.process.forms.current.label')}</dt>
        <dd data-testid={`form-current-${form.code}`}>
          {form.current_revision === null || form.current_revision === undefined ? t('pwf.process.forms.current.none') : t('pwf.process.forms.current.text', { revision: form.current_revision, from: dayText(form.current_effective_from) })}
        </dd>
        <dt>{t('pwf.process.forms.used.label')}</dt>
        <dd data-testid={`form-used-${form.code}`}>
          {form.used_revision === null || form.used_revision === undefined ? (
            form.satisfied ? (
              t('pwf.process.forms.used.unknown')
            ) : (
              t('pwf.process.forms.used.none')
            )
          ) : (
            <span title={form.used_sha256 ?? undefined}>{t('pwf6.forms.used.text', { revision: form.used_revision })}</span>
          )}
        </dd>
      </dl>
      {form.newer_available === true ? (
        <p className="callout warning pwf-notice" role="alert" data-testid={`form-newer-${form.code}`}>
          {t('pwf.process.forms.newer.text', { used: form.used_revision ?? 0, current: form.current_revision ?? 0 })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The legal grounds of a task (R45): what the task itself cites and what its step cites, as one list with the repeats folded and each ground marked with where it comes from. Nothing is shown for an answer kept from before these
 * facts existed, and nothing when neither cites anything.
 */
export function TaskProcessSection({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  if (task.step === undefined && task.legal_basis === undefined) return null;
  const merged = mergedBasis(task.legal_basis ?? [], task.step_legal_basis ?? []);
  const fromWord = (from: MergedBasis['from']): string => (from === 'task' ? t('pwf6.legal.from.task') : from === 'step' ? t('pwf6.legal.from.step') : t('pwf6.legal.from.both'));
  return (
    <SectionCard title={t('pwf6.legal.section.title')} status={merged.length === 0 ? undefined : <span className="pwf-hint">{t('pwf6.legal.count.text', { count: merged.length })}</span>}>
      <div data-testid="task-process">
        <LegalBasisList basis={merged.map((one) => one.basis)} of={task.name} testId="task-legal" origin={(index) => fromWord(merged[index]?.from ?? 'task')} />
      </div>
    </SectionCard>
  );
}
