import { useTranslation } from '../../../i18n';
import { codeKey, evidenceKindName } from '../codes';
import { dependencyWord, kindWord, priorityWord } from '../labels';
import { roleChoices } from './editor-choices';
import { CheckField, CodeListField, FieldFrame, NumberField, SelectField, TextField, problemMapOf } from './fields';
import { FormPicker } from './FormPicker';
import { KpiCodePicker } from './KpiCodePicker';
import { SideDrawer } from './SideDrawer';
import { extensionChoice, lineOf, setExtension, setKind } from './table-model';
import type { TableLine } from './table-model';
import {
  CONDITION_FIELDS,
  CONSTRAINT_KINDS,
  DEPENDENCY_KINDS,
  FORM_POLICY_KINDS,
  MAX_CHECKLIST,
  MAX_CONDITIONS,
  MAX_PREDECESSORS,
  PRIORITIES,
  TASK_KINDS,
  formPolicyOf,
  localProblems,
  renameStep,
  renameTask,
  setFormPolicy,
  stepsOf,
  updateStep,
  updateTask,
} from './template-model';
import type { ConditionField, ConstraintKind, EditorTask, FormPolicyKind, Template } from './template-model';

export interface StepDrawerProps {
  template: Template;
  /** The row the details are of (`step:<code>` or `task:<code>`). */
  /** The code of the procedure (made once from its name): shown here and nowhere else. */
  templateCode: string;
  lineKey: string;
  onChange: (next: Template) => void;
  onClose: () => void;
  /** The version is read-only: every field is shown and none can be changed. */
  disabled: boolean;
  /** Codes that the version in force already holds: a code in use by projects is never changed. */
  lockedCodes: ReadonlySet<string>;
  /** Whether the register of KPI may be read. */
  mayReadRegister: boolean;
}

const KINDS_OF_EVIDENCE = ['DOCUMENT', 'DECISION_DOCUMENT', 'MILESTONE', 'ATTESTATION'] as const;

/**
 * The details of a step, in four groups that say what each is for in plain words (the old screen had six tabs of a task): the papers a step asks for, who approves it and how urgent it is, the advanced links and
 * conditions of the schedule, and the KPI and the codes. Nothing a template can hold is left without a field here (R62). The caret goes in on opening and back to the row on closing; Escape closes.
 */
export function StepDrawer({ template, templateCode, lineKey, onChange, onClose, disabled, lockedCodes, mayReadRegister }: StepDrawerProps) {
  const { t } = useTranslation();
  const line = lineOf(template, lineKey);
  if (line === undefined) return null;
  const taskIndex = line.taskIndex;
  const task = taskIndex === null ? undefined : template.tasks[taskIndex];
  const stepIndex = line.kind === 'step' ? line.stepIndex : null;
  const step = stepIndex === null ? undefined : stepsOf(template)[stepIndex];
  const problems = problemMapOf(localProblems(template));
  return (
    <SideDrawer title={t('pwfx.drawer.title', { n: line.number, name: line.name.trim() === '' ? t('pwfx.phase.unnamed') : line.name })} onClose={onClose} testId="step-drawer">
      {disabled ? <p className="callout" role="status">{t('pwfx.drawer.readOnly')}</p> : null}
      {templateCode === '' ? null : (
        <p className="pwf-hint" data-testid="template-code">
          {t('pwfx.drawer.code.template', { code: templateCode })}
        </p>
      )}
      {task === undefined || taskIndex === null ? (
        <StepOnly template={template} line={line} step={step} onChange={onChange} disabled={disabled} lockedCodes={lockedCodes} />
      ) : (
        <TaskGroups template={template} line={line} index={taskIndex} task={task} onChange={onChange} disabled={disabled} lockedCodes={lockedCodes} problems={problems} mayReadRegister={mayReadRegister} />
      )}
    </SideDrawer>
  );
}

function StepOnly({ template, line, step, onChange, disabled, lockedCodes }: { template: Template; line: TableLine; step: ReturnType<typeof stepsOf>[number] | undefined; onChange: (next: Template) => void; disabled: boolean; lockedCodes: ReadonlySet<string> }) {
  const { t } = useTranslation();
  if (step === undefined || line.stepIndex === null) return null;
  const index = line.stepIndex;
  const problems = problemMapOf(localProblems(template));
  const codeLocked = disabled || lockedCodes.has(step.code);
  return (
    <section className="pwfx-group" aria-labelledby="pwfx-g-code">
      <h3 id="pwfx-g-code">{t('pwfx.drawer.codes.title')}</h3>
      <p className="pwf-hint">{line.taskIndexes.length === 0 ? t('pwfx.step.empty') : t('pwfx.step.several', { count: line.taskIndexes.length })}</p>
      <TextField label={t('pwfx.drawer.code.step')} path={`steps[${index}].code`} hint={codeLocked ? t('pwfx.drawer.code.locked') : t('pwfx.drawer.code.hint')} problems={problems} show value={step.code} disabled={codeLocked} onChange={(value) => onChange(renameStep(template, index, value.toUpperCase()))} />
      <TextField label={t('pwfx.drawer.step.role')} path={`steps[${index}].responsible_role`} problems={problems} show value={step.responsible_role ?? ''} disabled={disabled} onChange={(value) => onChange(updateStep(template, index, { responsible_role: value }))} />
    </section>
  );
}

function TaskGroups({ template, line, index, task, onChange, disabled, lockedCodes, problems, mayReadRegister }: { template: Template; line: TableLine; index: number; task: EditorTask; onChange: (next: Template) => void; disabled: boolean; lockedCodes: ReadonlySet<string>; problems: ReturnType<typeof problemMapOf>; mayReadRegister: boolean }) {
  const { t } = useTranslation();
  const at = `tasks[${index}]`;
  const patch = (value: Partial<EditorTask>): void => onChange(updateTask(template, index, value));
  const common = { problems, show: true, disabled };
  const others = template.tasks.map((one, position) => ({ one, position })).filter(({ position }) => position !== index);
  const codeLocked = disabled || lockedCodes.has(task.code);
  const used = [...new Set(template.tasks.map((one) => one.responsible_role).filter((code) => code !== ''))];
  const approverOptions = [{ value: '', label: t('pwfx.role.none') }, ...roleChoices(t, template, used, task.approver_role ?? '')];
  const step = line.stepIndex === null ? undefined : stepsOf(template)[line.stepIndex];
  const stepCodes = stepsOf(template).filter((one) => one.phase === task.phase);
  const optionsOf = <V extends string>(values: readonly V[], word: (value: V) => string): { value: V; label: string }[] => values.map((value) => ({ value, label: word(value) }));
  const ext = task.extension;
  return (
    <>
      <section className="pwfx-group" aria-labelledby={`${at}-g1`}>
        <h3 id={`${at}-g1`}>{t('pwfx.drawer.dossier.title')}</h3>
        <p className="pwf-hint">{t('pwfx.drawer.dossier.hint')}</p>
        <CodeListField label={t('pwf.templates.docs.legal.label')} path={`${at}.legal_doc_types`} hint={t('pwf.templates.docs.legal.hint')} value={task.legal_doc_types} onChange={(value) => patch({ legal_doc_types: value })} {...common} />
        <CodeListField label={t('pwf.templates.docs.forms.label')} path={`${at}.form_templates`} hint={t('pwf.templates.docs.forms.hint')} value={task.form_templates} onChange={(value) => patch({ form_templates: value })} {...common} />
        <FormPicker taskCode={task.code} value={task.form_templates} disabled={disabled} onChange={(value) => patch({ form_templates: value })} />
        {task.form_templates.length === 0 ? null : (
          <ul className="pwf-tpl-rows" data-testid="form-policies">
            {task.form_templates.map((form) => {
              const policy = formPolicyOf(task, form);
              const position = (task.form_policies ?? []).findIndex((one) => one.form === form);
              return (
                <li key={form} className="pwf-tpl-row" data-form={form}>
                  <SelectField
                    label={t('pwf.templates.forms.policy.label', { form })}
                    path={`${at}.form_policies.${form}.policy`}
                    value={policy.policy}
                    options={FORM_POLICY_KINDS.map((kind) => ({ value: kind, label: kind === 'PINNED' ? t('pwf.templates.forms.pinned.word') : t('pwf.templates.forms.latest.word') }))}
                    onChange={(kind: FormPolicyKind) => patch({ form_policies: setFormPolicy(task, form, kind, kind === 'PINNED' ? (policy.revision ?? 1) : null) })}
                    {...common}
                  />
                  {policy.policy === 'PINNED' ? (
                    <NumberField
                      label={t('pwf.templates.forms.revision.label')}
                      path={`${at}.form_policies[${position}].revision`}
                      hint={t('pwf.templates.forms.revision.hint')}
                      value={typeof policy.revision === 'number' ? policy.revision : Number.NaN}
                      onChange={(revision) => patch({ form_policies: (task.form_policies ?? []).map((one) => (one.form === form ? { form, policy: 'PINNED', revision } : one)) })}
                      {...common}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <fieldset className="pwf-tpl-sub">
          <legend>
            {t('pwf.templates.checklist.legend')} ({task.checklist.length}/{MAX_CHECKLIST})
          </legend>
          <ul className="pwf-tpl-rows" data-testid="checklist">
            {task.checklist.map((item, position) => {
              const change = (value: Partial<typeof item>): void => patch({ checklist: task.checklist.map((one, k) => (k === position ? { ...one, ...value } : one)) });
              return (
                <li key={position} className="pwf-tpl-row">
                  <TextField
                    grow
                    label={t('pwf.templates.checklist.name.label')}
                    path={`${at}.checklist[${position}].name`}
                    value={item.name}
                    onChange={(value) => change({ name: value })}
                    {...common}
                  />
                  <FieldFrame label={t('pwf.templates.checklist.evidence.label')} path={`${at}.checklist[${position}].evidence_kinds`} problems={problems} show>
                    {() => (
                      <span className="pwfx-evidence">
                        {[...new Set([...KINDS_OF_EVIDENCE, ...item.evidence_kinds])].map((kind) => (
                          <label key={kind} className="pwfx-check">
                            <input
                              type="checkbox"
                              checked={item.evidence_kinds.includes(kind)}
                              disabled={disabled}
                              onChange={(event) => change({ evidence_kinds: event.target.checked ? [...item.evidence_kinds, kind] : item.evidence_kinds.filter((one) => one !== kind) })}
                            />{' '}
                            {evidenceKindName(t, kind)}
                          </label>
                        ))}
                      </span>
                    )}
                  </FieldFrame>
                  <CheckField label={t('pwf.templates.checklist.required.label')} path={`${at}.checklist[${position}].required`} checked={item.required} disabled={disabled} onChange={(checked) => change({ required: checked })} />
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} onClick={() => patch({ checklist: task.checklist.filter((_, k) => k !== position) })}>
                    {t('pwf.templates.checklist.remove.action')}
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || task.checklist.length >= MAX_CHECKLIST} onClick={() => patch({ checklist: [...task.checklist, { code: '', name: '', required: true, evidence_kinds: [] }] })}>
            {t('pwf.templates.checklist.add.action')}
          </button>
        </fieldset>
      </section>

      <section className="pwfx-group" aria-labelledby={`${at}-g2`}>
        <h3 id={`${at}-g2`}>{t('pwfx.drawer.approval.title')}</h3>
        <p className="pwf-hint">{t('pwfx.drawer.approval.hint')}</p>
        <SelectField label={t('pwf.templates.task.approver.label')} path={`${at}.approver_role`} hint={t('pwf.templates.task.approver.hint')} value={task.approver_role ?? ''} options={approverOptions} onChange={(value) => patch({ approver_role: value === '' ? null : value })} {...common} />
        <SelectField label={t('pwf.templates.task.priority.label')} path={`${at}.priority`} value={task.priority} options={optionsOf(PRIORITIES, (value) => priorityWord(t, value))} onChange={(value) => patch({ priority: value })} {...common} />
        <SelectField label={t('pwf.templates.task.kind.label')} path={`${at}.kind`} value={task.kind} options={optionsOf(TASK_KINDS, (value) => kindWord(t, value))} onChange={(value) => onChange(setKind(template, index, value))} {...common} />
        <CheckField label={t('pwf.templates.task.required.label')} path={`${at}.required`} checked={task.required} disabled={disabled} onChange={(checked) => patch({ required: checked })} />
        {stepsOf(template).length === 0 ? null : (
          <SelectField
            label={t('pwf.templates.steps.task.label')}
            path={`${at}.step`}
            hint={t('pwf.templates.steps.task.hint')}
            value={task.step ?? ''}
            options={[{ value: '', label: t('pwf.templates.steps.pick.none') }, ...stepCodes.map((one) => ({ value: one.code, label: one.name === '' ? one.code : one.name }))]}
            onChange={(value) => patch({ step: value === '' ? null : value })}
            {...common}
          />
        )}
      </section>

      <section className="pwfx-group" aria-labelledby={`${at}-g3`}>
        <h3 id={`${at}-g3`}>{t('pwfx.drawer.schedule.title')}</h3>
        <p className="pwf-hint">{t('pwfx.drawer.schedule.hint')}</p>
        <fieldset className="pwf-tpl-sub">
          <legend>
            {t('pwf.templates.links.legend')} ({task.predecessors.length}/{MAX_PREDECESSORS})
          </legend>
          <ul className="pwf-tpl-rows" data-testid="predecessors">
            {task.predecessors.map((link, position) => {
              const change = (value: Partial<typeof link>): void => patch({ predecessors: task.predecessors.map((one, k) => (k === position ? { ...one, ...value } : one)) });
              const options = others.map(({ one }) => ({ value: one.code, label: one.name.trim() === '' ? one.code : one.name }));
              return (
                <li key={position} className="pwf-tpl-row">
                  <SelectField label={t('pwf.templates.link.task.label')} path={`${at}.predecessors[${position}].task`} value={link.task} options={options.some((option) => option.value === link.task) ? options : [{ value: link.task, label: link.task }, ...options]} onChange={(value) => change({ task: value })} {...common} />
                  <SelectField label={t('pwf.templates.link.kind.label')} path={`${at}.predecessors[${position}].kind`} value={link.kind} options={optionsOf(DEPENDENCY_KINDS, (value) => dependencyWord(t, value))} onChange={(value) => change({ kind: value })} {...common} />
                  <NumberField label={t('pwf.templates.link.lag.label')} path={`${at}.predecessors[${position}].lag_working_days`} hint={t('pwf.templates.link.lag.hint')} value={link.lag_working_days} onChange={(value) => change({ lag_working_days: value })} {...common} />
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} onClick={() => patch({ predecessors: task.predecessors.filter((_, k) => k !== position) })}>
                    {t('pwf.templates.link.remove.action')}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            disabled={disabled || others.length === 0 || task.predecessors.length >= MAX_PREDECESSORS}
            onClick={() => {
              const free = others.find(({ one }) => !task.predecessors.some((link) => link.task === one.code && link.kind === 'FS'));
              if (free !== undefined) patch({ predecessors: [...task.predecessors, { task: free.one.code, kind: 'FS', lag_working_days: 0 }] });
            }}
          >
            {t('pwf.templates.link.add.action')}
          </button>
        </fieldset>
        <fieldset className="pwf-tpl-sub">
          <legend>{t('pwf.templates.constraint.legend')}</legend>
          <SelectField
            label={t('pwf.templates.constraint.kind.label')}
            path={`${at}.constraint.kind`}
            value={task.constraint?.kind ?? 'NONE'}
            options={[{ value: 'NONE', label: t('pwf.templates.constraint.none.word') }, ...CONSTRAINT_KINDS.map((kind) => ({ value: kind, label: t(`pwf.templates.constraint.${kind.toLowerCase()}.word`) }))]}
            onChange={(value) => patch({ constraint: value === 'NONE' ? null : { kind: value as ConstraintKind, offset_working_days: task.constraint?.offset_working_days ?? 0 } })}
            {...common}
          />
          {task.constraint === null ? null : (
            <NumberField label={t('pwf.templates.constraint.offset.label')} path={`${at}.constraint.offset_working_days`} hint={t('pwf.templates.constraint.offset.hint')} value={task.constraint.offset_working_days} onChange={(value) => patch({ constraint: { kind: task.constraint?.kind ?? 'SNET', offset_working_days: value } })} {...common} />
          )}
        </fieldset>
        <fieldset className="pwf-tpl-sub">
          <legend>{t('pwf.templates.branch.legend')}</legend>
          <p className="pwf-hint">{t('pwf.templates.branch.hint')}</p>
          <ul className="pwf-tpl-rows" data-testid="branches">
            {task.when.map((condition, position) => (
              <li key={position} className="pwf-tpl-row">
                <SelectField
                  label={t('pwf.templates.branch.field.label')}
                  path={`${at}.when[${position}].field`}
                  value={condition.field}
                  options={CONDITION_FIELDS.map((field: ConditionField) => ({ value: field, label: field === 'project_group' ? t('pwf.templates.condition.projectGroup.word') : field === 'funding_source' ? t('pwf.templates.condition.fundingSource.word') : t('pwf.templates.condition.projectType.word') }))}
                  onChange={(value) => patch({ when: task.when.map((one, k) => (k === position ? { ...one, field: value } : one)) })}
                  {...common}
                />
                <CodeListField label={t('pwf.templates.branch.values.label')} path={`${at}.when[${position}].in`} value={condition.in} onChange={(value) => patch({ when: task.when.map((one, k) => (k === position ? { ...one, in: value } : one)) })} {...common} />
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} onClick={() => patch({ when: task.when.filter((_, k) => k !== position) })}>
                  {t('pwf.templates.branch.remove.action')}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || task.when.length >= MAX_CONDITIONS} onClick={() => patch({ when: [...task.when, { field: 'project_group', in: [] }] })}>
            {t('pwf.templates.branch.add.action')}
          </button>
        </fieldset>
        <SelectField
          label={t('pwfx.drawer.extension.choice')}
          path={`${at}.extension`}
          value={extensionChoice(task)}
          options={[
            { value: 'unset', label: t('pwfx.extension.unset') },
            { value: 'allowed', label: t('pwfx.extension.allowed') },
            { value: 'denied', label: t('pwfx.extension.denied') },
          ]}
          onChange={(value) => onChange(setExtension(template, index, value))}
          {...common}
        />
        {ext === undefined || !ext.allowed ? null : (
          <fieldset className="pwf-tpl-sub">
            <legend>{t('pwfx.drawer.extension.title')}</legend>
            <p className="pwf-hint">{t('pwfx.drawer.extension.hint')}</p>
            <NumberField label={t('pwfx.drawer.extension.times')} path={`${at}.extension.max_times`} value={ext.max_times ?? Number.NaN} onChange={(value) => onChange(setExtension(template, index, 'allowed', { max_times: Number.isNaN(value) ? undefined : value }))} {...common} />
            <NumberField label={t('pwfx.drawer.extension.value', { unit: t(`pwfx.limit.unit.${codeKey(ext.unit)}`) })} path={`${at}.extension.max_value`} value={ext.max_value ?? Number.NaN} onChange={(value) => onChange(setExtension(template, index, 'allowed', { max_value: Number.isNaN(value) ? undefined : value }))} {...common} />
          </fieldset>
        )}
      </section>

      <section className="pwfx-group" aria-labelledby={`${at}-g4`}>
        <h3 id={`${at}-g4`}>{t('pwfx.drawer.codes.title')}</h3>
        <p className="pwf-hint">{t('pwfx.drawer.codes.hint')}</p>
        <CodeListField label={t('pwf.templates.docs.kpi.label')} path={`${at}.kpi_codes`} hint={t('pwf.templates.docs.kpi.hint')} value={task.kpi_codes} onChange={(value) => patch({ kpi_codes: value })} {...common} />
        <KpiCodePicker taskCode={task.code} value={task.kpi_codes} disabled={disabled} enabled={mayReadRegister} onChange={(value) => patch({ kpi_codes: value })} />
        <TextField
          label={t('pwfx.drawer.code.task')}
          path={`${at}.code`}
          hint={codeLocked ? t('pwfx.drawer.code.locked') : t('pwfx.drawer.code.hint')}
          value={task.code}
          disabled={codeLocked}
          onChange={(value) => onChange(renameTask(template, index, value.toUpperCase()))}
          {...{ problems, show: true }}
        />
        {step === undefined ? null : <p className="pwf-hint">{t('pwfx.drawer.code.stepNote', { code: step.code })}</p>}
      </section>
    </>
  );
}
