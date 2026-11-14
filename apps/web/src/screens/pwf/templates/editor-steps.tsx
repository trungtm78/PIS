import { useQueries } from '@tanstack/react-query';
import { useId } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { useCatalogue, useScopeKey } from '../../adm/governance/hooks';
import { toResolved } from '../../adm/governance/model';
import { docKindWord } from '../process/labels';
import { NumberField, SelectField, TextField } from './editor-fields';
import type { ProblemMap } from './editor-fields';
import {
  FORM_POLICY_KINDS,
  MAX_LEGAL_BASIS,
  MAX_STEPS,
  addStep,
  disableSteps,
  enableSteps,
  formPolicyOf,
  groupSteps,
  hasSteps,
  removeStep,
  renameStep,
  setFormPolicy,
  stepsOf,
  updateStep,
} from './template-model';
import type { EditorTask, FormPolicy, FormPolicyKind, LegalBasisInput, Template } from './template-model';

const LEGAL_DOCUMENT = 'LEGAL_DOCUMENT';

/**
 * What people call each document of the catalogue (its kind and number, "Nghị định 85/2025/NĐ-CP"), read from the rule in force of each code: the picker of a legal ground shows the name and keeps the code as a note. A
 * document whose rule cannot be read has no name here and is shown by its code; nothing waits for the names.
 */
export function useLegalDocumentNames(codes: readonly string[]): ReadonlyMap<string, string> {
  const { t } = useTranslation();
  const client = useApiClient();
  const key = useScopeKey();
  const found = useQueries({
    queries: codes.map((code) => ({
      queryKey: [...key, 'pwf-legal-document', code],
      enabled: key[1] !== undefined,
      retry: false,
      staleTime: 300_000,
      queryFn: async (): Promise<string | null> => {
        const rule = toResolved(await client.read('getEffectiveGovernanceRule' as never, { query: { rule_type: LEGAL_DOCUMENT, code } } as never).catch(() => null));
        const params = rule?.params as { doc_kind?: unknown; number?: unknown } | undefined;
        return typeof params?.number === 'string' && params.number !== '' ? `${typeof params.doc_kind === 'string' ? `${docKindWord(t, params.doc_kind as never)} ` : ''}${params.number}` : null;
      },
    })),
  });
  const names = new Map<string, string>();
  codes.forEach((code, index) => {
    const name = found[index]?.data;
    if (typeof name === 'string') names.set(code, name);
  });
  return names;
}

/** The codes of the shared catalogue of legal documents (R45), as the rule store lists them; empty while it is read or when it cannot be read (the code is then typed). */
export function useLegalDocumentCodes(): string[] {
  const catalogue = useCatalogue(true);
  return catalogue.data?.find((one) => one.ruleType === LEGAL_DOCUMENT)?.codes.map((code) => code.code) ?? [];
}

export interface LegalBasisEditorProps {
  /** The path of the part the grounds belong to (`steps[0]`, `tasks[3]`). */
  at: string;
  value: readonly LegalBasisInput[];
  onChange: (value: LegalBasisInput[]) => void;
  documents: readonly string[];
  problems: ProblemMap;
  show: boolean;
  disabled: boolean;
  /** Open from the start (the tab of the legal grounds of a task shows nothing else). */
  open?: boolean;
}

/**
 * The legal grounds of a step or of a task (R45): each cites a document of the shared catalogue by its code, the article when it is known (left empty rather than guessed) and whether a legal officer confirmed the citation. The
 * words of the document are never typed here: the catalogue holds them, so one change there reaches every template that cites it.
 */
export function LegalBasisEditor({ at, value, onChange, documents, problems, show, disabled, open }: LegalBasisEditorProps) {
  const names = useLegalDocumentNames(documents);
  const { t } = useTranslation();
  const listId = useId();
  const patch = (index: number, change: Partial<LegalBasisInput>): void => onChange(value.map((one, position) => (position === index ? { ...one, ...change } : one)));
  const common = { problems, show, disabled };
  return (
    <details className="pwf-tpl-sub pwf-tpl-fold" data-testid={`legal-fold-${at}`} open={open === true || (show && [...problems.keys()].some((path) => path.startsWith(`${at}.legal_basis`)))}>
      <summary>{t('pwf.templates.legal.legend.text', { count: value.length, max: MAX_LEGAL_BASIS })}</summary>
      <p className="adm-kit-sub">{t('pwf.templates.legal.hint.text')}</p>
      <datalist id={listId}>
        {documents.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>
      <ul className="pwf-tpl-rows" data-testid={`legal-${at}`}>
        {value.map((one, index) => {
          const base = `${at}.legal_basis[${index}]`;
          const unknown = documents.length > 0 && one.document !== '' && !documents.includes(one.document);
          return (
            <li key={index} className="pwf-tpl-row">
              <div className="pwf-field">
                <TextField label={t('pwf.templates.legal.document.label')} path={`${base}.document`} value={one.document} onChange={(document) => patch(index, { document: document.toUpperCase() })} {...common} />
                <label className="pwf-hint" htmlFor={`${listId}-pick-${index}`}>
                  {t('pwf.templates.legal.pick.label')}
                </label>
                <select id={`${listId}-pick-${index}`} value={documents.includes(one.document) ? one.document : ''} disabled={disabled || documents.length === 0} data-testid={`pick-${base}.document`} onChange={(event) => patch(index, { document: event.target.value })}>
                  <option value="">{t('pwf.templates.legal.pick.none')}</option>
                  {documents.map((code) => (
                    <option key={code} value={code}>
                      {names.get(code) === undefined ? code : t('fix8.legal.pick.option', { name: names.get(code) ?? '', code })}
                    </option>
                  ))}
                </select>
                {names.get(one.document) === undefined ? null : (
                  <span className="pwf-hint" data-testid={`name-${base}.document`}>
                    {names.get(one.document)}
                  </span>
                )}
                {unknown ? (
                  <span className="pwf-field__error" role="status" data-testid={`unknown-${base}.document`}>
                    <span aria-hidden="true">⚠ </span>
                    {t('pwf.templates.legal.unknown.text')}
                  </span>
                ) : null}
              </div>
              <TextField label={t('pwf.templates.legal.article.label')} path={`${base}.article`} hint={t('pwf.templates.legal.article.hint')} value={one.article ?? ''} onChange={(article) => patch(index, { article })} {...common} />
              <TextField label={t('pwf.templates.legal.note.label')} path={`${base}.note`} value={one.note ?? ''} onChange={(note) => patch(index, { note })} {...common} />
              <SelectField
                label={t('pwf.templates.legal.verification.label')}
                path={`${base}.verification`}
                value={one.verification}
                options={[
                  { value: 'UNVERIFIED', label: t('pwf.process.legal.unverified.word') },
                  { value: 'VERIFIED', label: t('pwf.process.legal.verified.word') },
                ]}
                onChange={(verification) => patch(index, { verification })}
                {...common}
              />
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-basis-${at}-${index}`} onClick={() => onChange(value.filter((_, position) => position !== index))}>
                {t('pwf.templates.legal.remove.action')}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || value.length >= MAX_LEGAL_BASIS} data-action={`add-basis-${at}`} onClick={() => onChange([...value, { document: '', verification: 'UNVERIFIED' }])}>
        {t('pwf.templates.legal.add.action')}
      </button>
    </details>
  );
}

export interface StepsEditorProps {
  template: Template;
  onChange: (template: Template) => void;
  problems: ProblemMap;
  show: boolean;
  disabled: boolean;
}

/**
 * The steps of the phases (R44): a template is either in two tiers (every phase is one step) or names its steps, each in one phase, with the role that answers for it and its legal grounds. The time of a step is never typed: it is
 * what the schedule of its tasks gives (the preview below shows it).
 */
export function StepsEditor({ template, onChange, problems, show, disabled }: StepsEditorProps) {
  const { t } = useTranslation();
  const documents = useLegalDocumentCodes();
  const steps = stepsOf(template);
  const phaseOptions = template.phases.map((phase) => ({ value: phase.code, label: phase.name === '' ? phase.code : phase.name }));
  const common = { problems, show, disabled };
  return (
    <SectionCard title={t('pwf.templates.steps.section.title')} status={<span data-testid="steps-count">{t('pwf.templates.limit.text', { count: steps.length, max: MAX_STEPS })}</span>}>
      {!hasSteps(template) ? (
        <div data-testid="steps-off">
          <p className="callout" role="status">
            {t('pwf.templates.steps.off.text')}
          </p>
          <p className="pwf-actions">
            <button type="button" className="ui-button ui-button--outline" disabled={disabled || template.phases.length === 0} data-action="enable-steps" onClick={() => onChange(enableSteps(template))}>
              {t('pwf.templates.steps.enable.action')}
            </button>
          </p>
        </div>
      ) : (
        <div data-testid="steps">
          <p className="adm-kit-sub">{t('pwf.templates.steps.hint.text')}</p>
          {groupSteps(template).map((group) => (
            <section key={group.phase?.code ?? 'none'} data-step-phase={group.phase?.code ?? ''} aria-label={group.phase === null ? t('pwf.templates.steps.orphans.text') : `${group.phase.code} · ${group.phase.name}`}>
              <h3>
                {group.phase === null ? t('pwf.templates.steps.orphans.text') : group.phase.name === '' ? group.phase.code : group.phase.name} {group.phase === null || group.phase.name === '' ? null : <span className="pwf-code">{group.phase.code}</span>}
              </h3>
              <ol className="pwf-tpl-rows">
                {group.steps.map(({ index, step, tasks }) => {
                  const at = `steps[${index}]`;
                  return (
                    <li key={index} data-step={step.code}>
                      <div className="pwf-tpl-row">
                        <TextField label={t('pwf.templates.steps.code.label')} path={`${at}.code`} value={step.code} onChange={(code) => onChange(renameStep(template, index, code))} {...common} />
                        <TextField label={t('pwf.templates.steps.name.label')} path={`${at}.name`} value={step.name} onChange={(name) => onChange(updateStep(template, index, { name }))} {...common} />
                        <SelectField label={t('pwf.templates.steps.phase.label')} path={`${at}.phase`} value={step.phase} options={phaseOptions.some((option) => option.value === step.phase) ? phaseOptions : [{ value: step.phase, label: step.phase }, ...phaseOptions]} onChange={(phase) => onChange(updateStep(template, index, { phase }))} {...common} />
                        <TextField label={t('pwf.templates.steps.role.label')} path={`${at}.responsible_role`} hint={t('pwf.templates.steps.role.hint')} value={step.responsible_role ?? ''} onChange={(role) => onChange(updateStep(template, index, { responsible_role: role }))} {...common} />
                        <span data-testid={`step-tasks-${index}`}>
                          <StatusPill tone={tasks === 0 ? 'warning' : 'neutral'} icon={tasks === 0 ? '⚠' : undefined}>
                            {t('pwf.templates.steps.tasks.text', { count: tasks })}
                          </StatusPill>
                        </span>
                        <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-step-${index}`} onClick={() => onChange(removeStep(template, index))}>
                          {t('pwf.templates.steps.remove.action')}
                        </button>
                      </div>
                      {show && problems.get(`${at}.tasks`) !== undefined ? (
                        <p className="pwf-field__error" role="alert" data-testid={`error-${at}.tasks`}>
                          <span aria-hidden="true">⚠ </span>
                          {t('pwf.templates.steps.noTasks.error')}
                        </p>
                      ) : null}
                      <LegalBasisEditor at={at} value={step.legal_basis ?? []} onChange={(basis) => onChange(updateStep(template, index, { legal_basis: basis }))} documents={documents} {...common} />
                    </li>
                  );
                })}
              </ol>
              {group.phase === null ? null : (
                <p className="pwf-actions">
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || steps.length >= MAX_STEPS} data-action={`add-step-${group.phase.code}`} onClick={() => onChange(addStep(template, group.phase?.code ?? ''))}>
                    {t('pwf.templates.steps.add.action')}
                  </button>
                </p>
              )}
            </section>
          ))}
          <p className="pwf-actions">
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action="disable-steps" onClick={() => onChange(disableSteps(template))}>
              {t('pwf.templates.steps.disable.action')}
            </button>
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function policyWord(t: ReturnType<typeof useTranslation>['t'], policy: FormPolicyKind): string {
  switch (policy) {
    case 'LATEST_APPROVED':
      return t('pwf.templates.forms.latest.word');
    case 'PINNED':
      return t('pwf.templates.forms.pinned.word');
  }
}

export interface TaskProcessFieldsProps {
  template: Template;
  index: number;
  task: EditorTask;
  onPatch: (patch: Partial<EditorTask>) => void;
  problems: ProblemMap;
  show: boolean;
  disabled: boolean;
  /** One part only (the tabs of a task show each part where its purpose is); all three when left out. */
  part?: 'step' | 'legal' | 'forms';
}

/** The parts of a task that say where it stands in the procedure (R44, R45, R46): its step, its own legal grounds, and for each of its forms whether the newest approved revision is used or one revision is pinned. */
export function TaskProcessFields({ template, index, task, onPatch, problems, show, disabled, part }: TaskProcessFieldsProps) {
  const { t } = useTranslation();
  const documents = useLegalDocumentCodes();
  const at = `tasks[${index}]`;
  const common = { problems, show, disabled };
  const inPhase = stepsOf(template).filter((step) => step.phase === task.phase);
  const stepOptions = [{ value: '', label: t('pwf.templates.steps.pick.none') }, ...inPhase.map((step) => ({ value: step.code, label: `${step.code} · ${step.name}` }))];
  const current = task.step ?? '';
  const policyIndex = (form: string): number => (task.form_policies ?? []).findIndex((one) => one.form === form);
  return (
    <>
      {hasSteps(template) && (part === undefined || part === 'step') ? (
        <fieldset className="pwf-tpl-sub">
          <legend>{t('pwf.templates.steps.task.legend')}</legend>
          <div className="pwf-tpl-row">
            <SelectField
              label={t('pwf.templates.steps.task.label')}
              path={`${at}.step`}
              hint={t('pwf.templates.steps.task.hint')}
              value={current}
              options={stepOptions.some((option) => option.value === current) ? stepOptions : [...stepOptions, { value: current, label: current }]}
              onChange={(step) => onPatch({ step: step === '' ? null : step })}
              {...common}
            />
          </div>
        </fieldset>
      ) : null}
      {part === undefined || part === 'legal' ? <LegalBasisEditor at={at} value={task.legal_basis ?? []} onChange={(basis) => onPatch({ legal_basis: basis })} documents={documents} open={part === 'legal'} {...common} /> : null}
      {task.form_templates.length === 0 || !(part === undefined || part === 'forms') ? null : (
        <fieldset className="pwf-tpl-sub">
          <legend>{t('pwf.templates.forms.legend.text')}</legend>
          <p className="adm-kit-sub">{t('pwf.templates.forms.hint.text')}</p>
          <ul className="pwf-tpl-rows" data-testid="form-policies">
            {task.form_templates.map((form) => {
              const policy: FormPolicy = formPolicyOf(task, form);
              const position = policyIndex(form);
              return (
                <li key={form} className="pwf-tpl-row" data-form={form}>
                  <SelectField
                    label={t('pwf.templates.forms.policy.label', { form })}
                    path={`${at}.form_policies.${form}.policy`}
                    value={policy.policy}
                    options={FORM_POLICY_KINDS.map((kind) => ({ value: kind, label: policyWord(t, kind) }))}
                    onChange={(kind) => onPatch({ form_policies: setFormPolicy(task, form, kind, kind === 'PINNED' ? (policy.revision ?? 1) : null) })}
                    {...common}
                  />
                  {policy.policy === 'PINNED' ? (
                    <NumberField
                      label={t('pwf.templates.forms.revision.label')}
                      path={`${at}.form_policies[${position}].revision`}
                      hint={t('pwf.templates.forms.revision.hint')}
                      value={typeof policy.revision === 'number' ? policy.revision : Number.NaN}
                      onChange={(revision) => onPatch({ form_policies: (task.form_policies ?? []).map((one) => (one.form === form ? { form, policy: 'PINNED', revision } : one)) })}
                      {...common}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
    </>
  );
}
