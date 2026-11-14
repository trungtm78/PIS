import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { SectionCard, StatusPill, Tabs } from '../../../ui';
import { roleKnown, roleName } from '../codes';
import { FigureInfo } from '../components';
import { dependencyWord, gateWord, kindWord, priorityWord } from '../labels';
import { CheckField, CodeListField, NumberField, SelectField, TextField } from './editor-fields';
import { TaskProcessFields } from './editor-steps';
import { FormPicker } from './FormPicker';
import { KpiCodePicker } from './KpiCodePicker';
import type { ProblemMap } from './editor-fields';
import {
  CONDITION_FIELDS,
  CONSTRAINT_KINDS,
  DEPENDENCY_KINDS,
  GATE_TARGETS,
  MAX_CHECKLIST,
  MAX_CONDITIONS,
  MAX_PHASES,
  MAX_PREDECESSORS,
  MAX_ROLES,
  MAX_TASKS,
  PRIORITIES,
  TASK_KINDS,
  addPhase,
  addPredecessor,
  addTask,
  groupByPhase,
  nameRole,
  removePhase,
  removeTask,
  renamePhase,
  renameTask,
  updatePhase,
  updateTask,
} from './template-model';
import type { ConditionField, ConstraintKind, EditorTask, Template } from './template-model';
import { stepsOf, templateRoleName, usedRoleCodes } from './template-model';
import { problemWord } from './editor-fields';

type T = Translator['t'];

export interface PanelProps {
  template: Template;
  onChange: (template: Template) => void;
  problems: ProblemMap;
  show: boolean;
  disabled: boolean;
}

const optionsOf = <V extends string>(values: readonly V[], word: (value: V) => string): { value: V; label: string }[] => values.map((value) => ({ value, label: word(value) }));

function constraintWord(t: T, kind: ConstraintKind): string {
  switch (kind) {
    case 'SNET':
      return t('pwf.templates.constraint.snet.word');
    case 'SNLT':
      return t('pwf.templates.constraint.snlt.word');
    case 'FNET':
      return t('pwf.templates.constraint.fnet.word');
    case 'FNLT':
      return t('pwf.templates.constraint.fnlt.word');
    case 'MSO':
      return t('pwf.templates.constraint.mso.word');
    case 'MFO':
      return t('pwf.templates.constraint.mfo.word');
  }
}

function conditionWord(t: T, field: ConditionField): string {
  switch (field) {
    case 'project_group':
      return t('pwf.templates.condition.projectGroup.word');
    case 'funding_source':
      return t('pwf.templates.condition.fundingSource.word');
    case 'project_type':
      return t('pwf.templates.condition.projectType.word');
  }
}

/** The limit counter of a part of the template: "3 of 12", with the "i" that says where the limit comes from (BR-PWF-12). */
function Limit({ name, count, max }: { name: string; count: number; max: number }) {
  const { t } = useTranslation();
  return (
    <span className="pwf-figure" data-testid="limit">
      <span>{t('pwf.templates.limit.text', { count, max })}</span>
      <FigureInfo name={name} formula={t('pwf.templates.limit.formula')} source={t('pwf.templates.limit.source')} asOf={null} version={t('pwf.templates.limit.version')} />
    </span>
  );
}

// ---- the phases ---------------------------------------------------------------------------------------------------------------------------------------------------------

export function PhasesPanel({ template, onChange, problems, show, disabled }: PanelProps) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('pwf.templates.phases.title')} status={<Limit name={t('pwf.templates.phases.title')} count={template.phases.length} max={MAX_PHASES} />}>
      <ol className="pwf-tpl-rows" data-testid="phases">
        {template.phases.map((phase, index) => (
          <li key={index} data-phase={phase.code}>
            <div className="pwf-tpl-row">
              <TextField label={t('pwf.templates.phase.code.label')} path={`phases[${index}].code`} problems={problems} show={show} value={phase.code} disabled={disabled} onChange={(value) => onChange(renamePhase(template, index, value))} />
              <TextField label={t('pwf.templates.phase.name.label')} path={`phases[${index}].name`} problems={problems} show={show} value={phase.name} disabled={disabled} onChange={(value) => onChange(updatePhase(template, index, { name: value }))} />
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-phase-${index}`} onClick={() => onChange(removePhase(template, index))}>
                {t('pwf.templates.phase.remove.action')}
              </button>
            </div>
            <fieldset className="pwf-tpl-checks">
              <legend>{t('pwf.templates.phase.gates.legend')}</legend>
              {GATE_TARGETS.map((target) => (
                <CheckField
                  key={target}
                  label={gateWord(t, target)}
                  path={`phases[${index}].gates.${target}`}
                  disabled={disabled}
                  checked={phase.gates.includes(target)}
                  onChange={(checked) => onChange(updatePhase(template, index, { gates: GATE_TARGETS.filter((one) => (one === target ? checked : phase.gates.includes(one))) }))}
                />
              ))}
            </fieldset>
          </li>
        ))}
      </ol>
      {show && problems.get('phases') !== undefined ? (
        <p className="pwf-field__error" role="alert" data-testid="error-phases">
          {t('pwf.templates.phases.required.error')}
        </p>
      ) : null}
      <p className="pwf-actions">
        <button type="button" className="ui-button ui-button--outline" disabled={disabled || template.phases.length >= MAX_PHASES} data-action="add-phase" onClick={() => onChange(addPhase(template))}>
          {t('pwf.templates.phase.add.action')}
        </button>
      </p>
    </SectionCard>
  );
}

// ---- the task tree and the task ----------------------------------------------------------------------------------------------------------------------------------

export interface TasksPanelProps extends PanelProps {
  selected: number | undefined;
  onSelect: (index: number | undefined) => void;
}

export function TasksPanel({ template, onChange, problems, show, disabled, selected, onSelect }: TasksPanelProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState('');
  // The tab of the task that is open stays the same when another task is picked (whoever fills the checklists goes from task to task).
  const [part, setPart] = useState<TaskPart>('info');
  const target = template.phases.some((one) => one.code === phase) ? phase : (template.phases[0]?.code ?? '');
  const groups = groupByPhase(template);
  const task = selected === undefined ? undefined : template.tasks[selected];
  const hasProblem = (index: number): boolean => show && [...problems.keys()].some((path) => path.startsWith(`tasks[${index}].`));
  return (
    <SectionCard title={t('pwf.templates.tasks.title')} status={<Limit name={t('pwf.templates.tasks.title')} count={template.tasks.length} max={MAX_TASKS} />}>
      <div className="pwf-tpl-editor">
        <div>
          <ul className="pwf-tpl-tree" aria-label={t('pwf.templates.tasks.tree.label')} data-testid="tree">
            {groups.map((group) => {
              const steps = group.phase === null ? [] : stepsOf(template).filter((step) => step.phase === group.phase?.code);
              const known = new Set(steps.map((step) => step.code));
              const loose = group.tasks.filter((item) => item.task.step === null || item.task.step === undefined || !known.has(item.task.step));
              const pick = (item: (typeof group.tasks)[number]) => (
                <li key={item.index}>
                  <button type="button" className="pwf-tpl-pick" aria-current={selected === item.index} data-testid={`pick-${item.index}`} onClick={() => onSelect(item.index)}>
                    <span className="pwf-taskname">
                      <span className="pwf-tpl-pick__name">{item.task.name === '' ? t('pwf.templates.lib.noName.text') : item.task.name}</span>
                      <span className="pwf-code pwf-taskname__code">{item.task.code}</span>
                    </span>
                    <span className="pwf-tpl-pick__facts">
                      <span className="pwf-hint">{t('pwf6.editor.tree.days', { days: item.task.duration_working_days })}</span>
                      {item.task.checklist.length === 0 ? null : <span className="pwf-hint">{t('pwf6.editor.tree.checklist', { count: item.task.checklist.length })}</span>}
                      {item.task.kind === 'MILESTONE' ? <StatusPill tone="info" icon="◆">{kindWord(t, 'MILESTONE')}</StatusPill> : null}
                      {item.task.required ? null : <StatusPill tone="neutral">{t('pwf.templates.task.optional.word')}</StatusPill>}
                      {hasProblem(item.index) ? <StatusPill tone="danger" icon="⚠">{t('pwf.templates.task.problem.word')}</StatusPill> : null}
                    </span>
                  </button>
                </li>
              );
              return (
                <li key={group.phase?.code ?? 'none'} data-phase={group.phase?.code ?? ''}>
                  <span className="pwf-tpl-tree__phase">
                    <strong>{group.phase === null ? t('pwf.templates.tasks.orphans.text') : group.phase.name === '' ? group.phase.code : group.phase.name}</strong>
                    {group.phase === null || group.phase.name === '' ? null : <span className="pwf-code">{group.phase.code}</span>}
                    <span className="pwf-hint">{t('pwf6.editor.tree.count', { count: group.tasks.length })}</span>
                  </span>
                  {steps.length === 0 ? (
                    <ul>{group.tasks.map(pick)}</ul>
                  ) : (
                    <ul>
                      {steps.map((step) => (
                        <li key={step.code} data-tree-step={step.code}>
                          <span className="pwf-tpl-tree__step">
                            {step.name === '' ? step.code : step.name} {step.name === '' ? null : <span className="pwf-code">{step.code}</span>}
                          </span>
                          <ul>{group.tasks.filter((item) => item.task.step === step.code).map(pick)}</ul>
                        </li>
                      ))}
                      {loose.length === 0 ? null : (
                        <li data-tree-step="">
                          <span className="pwf-tpl-tree__step">{t('pwf6.editor.tree.noStep')}</span>
                          <ul>{loose.map(pick)}</ul>
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {show && problems.get('tasks') !== undefined ? (
            <p className="pwf-field__error" role="alert" data-testid="error-tasks">
              {t('pwf.templates.tasks.required.error')}
            </p>
          ) : null}
          <div className="pwf-actions">
            <div className="pwf-field">
              <label htmlFor="pwf-add-task-phase">{t('pwf.templates.task.addPhase.label')}</label>
              <select id="pwf-add-task-phase" value={target} disabled={disabled || template.phases.length === 0} data-testid="add-task-phase" onChange={(event) => setPhase(event.target.value)}>
                {template.phases.map((one) => (
                  <option key={one.code} value={one.code}>
                    {one.name === '' ? one.code : one.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="ui-button ui-button--outline"
              disabled={disabled || template.phases.length === 0 || template.tasks.length >= MAX_TASKS}
              data-action="add-task"
              onClick={() => {
                const next = addTask(template, target);
                onChange(next);
                onSelect(next.tasks.length - 1);
              }}
            >
              {t('pwf.templates.task.add.action')}
            </button>
          </div>
        </div>
        <div data-testid="task-panel">
          {task === undefined || selected === undefined ? (
            <p className="callout" role="status" data-testid="task-pick">
              {t('pwf.templates.task.pick.text')}
            </p>
          ) : (
            <TaskPanel template={template} index={selected} task={task} onChange={onChange} problems={problems} show={show} disabled={disabled} part={part} onPart={setPart} onRemove={() => {
              onChange(removeTask(template, selected));
              onSelect(undefined);
            }} />
          )}
        </div>
      </div>
    </SectionCard>
  );
}

/**
 * The parts of one task, a tab each (owner review of 14/11/2026: the form of a task was one long column). One purpose a tab: what the task is and who does it; its time and what it waits for; the documents and forms it needs; its
 * checklist; the KPI measured on it; its legal grounds. Legal grounds, forms and KPI are tabs of the TASK and not of the screen, because each belongs to one task: a tab of the screen would take them away from the task they describe and
 * make the author pick the task again in every tab.
 */
export const TASK_PARTS = ['info', 'schedule', 'docs', 'checklist', 'kpi', 'legal'] as const;
export type TaskPart = (typeof TASK_PARTS)[number];

/** The tab a field of a task sits in, from its path under the task (`checklist[0].name`). */
export function taskPartOf(field: string): TaskPart {
  if (/^(duration_working_days|constraint|predecessors)/.test(field)) return 'schedule';
  if (/^(legal_doc_types|form_templates|form_policies)/.test(field)) return 'docs';
  if (field.startsWith('checklist')) return 'checklist';
  if (field.startsWith('kpi_codes')) return 'kpi';
  if (field.startsWith('legal_basis')) return 'legal';
  return 'info';
}

interface TaskPanelProps extends PanelProps {
  index: number;
  task: EditorTask;
  onRemove: () => void;
  part: TaskPart;
  onPart: (part: TaskPart) => void;
}

function TaskPanel({ template, index, task, onChange, problems, show, disabled, onRemove, part, onPart }: TaskPanelProps) {
  const { t } = useTranslation();
  const at = `tasks[${index}]`;
  // A problem in a tab that is not open is counted on its tab, once the problems are shown: nobody opens six tabs to find one field.
  const countOf = (id: TaskPart): number | undefined => {
    if (!show) return undefined;
    const found = [...problems.keys()].filter((path) => path.startsWith(`${at}.`) && taskPartOf(path.slice(at.length + 1)) === id).length;
    return found === 0 ? undefined : found;
  };
  // What a role code is called: the name this template gives it, else the shipped catalogue; a code nobody named says where to name it.
  const roleHint = (code: string): string | undefined => {
    if (code.trim() === '') return undefined;
    const name = templateRoleName(template, code) ?? (roleKnown(code) ? roleName(t, code) : undefined);
    return name === undefined ? t('fix8.editor.role.unnamed.hint') : t('fix8.editor.role.named.hint', { name });
  };
  const patch = (value: Partial<EditorTask>): void => onChange(updateTask(template, index, value));
  const phaseCodes = template.phases.map((phase) => phase.code);
  const phaseOptions = (phaseCodes.includes(task.phase) ? phaseCodes : [task.phase, ...phaseCodes]).map((value) => ({ value, label: value === '' ? t('pwf.templates.task.noPhase.option') : value }));
  const others = template.tasks.filter((_, at2) => at2 !== index).map((one) => one.code);
  const common = { problems, show, disabled };
  return (
    <div data-task={task.code}>
      <h3>{t('pwf.templates.task.title', { code: task.code })}</h3>
      <Tabs
        label={t('fix8.editor.parts.label')}
        testId="task-parts"
        value={part}
        onChange={onPart}
        tabs={[
          {
            id: 'info',
            label: t('fix8.editor.part.info'),
            count: countOf('info'),
            panel: (
              <>
            <div className="pwf-tpl-row">
              <TextField label={t('pwf.templates.task.code.label')} path={`${at}.code`} value={task.code} onChange={(value) => onChange(renameTask(template, index, value))} {...common} />
              <TextField label={t('pwf.templates.task.name.label')} path={`${at}.name`} value={task.name} onChange={(value) => patch({ name: value })} {...common} />
              <SelectField label={t('pwf.templates.task.phase.label')} path={`${at}.phase`} value={task.phase} options={phaseOptions} onChange={(value) => patch({ phase: value })} {...common} />
              <SelectField label={t('pwf.templates.task.kind.label')} path={`${at}.kind`} value={task.kind} options={optionsOf(TASK_KINDS, (value) => kindWord(t, value))} onChange={(value) => patch({ kind: value })} {...common} />
              <SelectField label={t('pwf.templates.task.priority.label')} path={`${at}.priority`} value={task.priority} options={optionsOf(PRIORITIES, (value) => priorityWord(t, value))} onChange={(value) => patch({ priority: value })} {...common} />
              <TextField label={t('pwf.templates.task.responsible.label')} path={`${at}.responsible_role`} hint={roleHint(task.responsible_role)} value={task.responsible_role} onChange={(value) => patch({ responsible_role: value })} {...common} />
              <TextField label={t('pwf.templates.task.approver.label')} path={`${at}.approver_role`} hint={t('pwf.templates.task.approver.hint')} value={task.approver_role ?? ''} onChange={(value) => patch({ approver_role: value === '' ? null : value })} {...common} />
              <CheckField label={t('pwf.templates.task.required.label')} path={`${at}.required`} checked={task.required} disabled={disabled} onChange={(checked) => patch({ required: checked })} />
            </div>
            <TaskProcessFields template={template} index={index} task={task} onPatch={patch} problems={problems} show={show} disabled={disabled} part="step" />
            <fieldset className="pwf-tpl-sub">
              <legend>{t('pwf.templates.branch.legend')}</legend>
              <p className="adm-kit-sub">{t('pwf.templates.branch.hint')}</p>
              <ul className="pwf-tpl-rows" data-testid="branches">
                {task.when.map((condition, at2) => (
                  <li key={at2} className="pwf-tpl-row">
                    <SelectField
                      label={t('pwf.templates.branch.field.label')}
                      path={`${at}.when[${at2}].field`}
                      value={condition.field}
                      options={optionsOf(CONDITION_FIELDS, (value) => conditionWord(t, value))}
                      onChange={(value) => patch({ when: task.when.map((one, k) => (k === at2 ? { ...one, field: value } : one)) })}
                      {...common}
                    />
                    <CodeListField label={t('pwf.templates.branch.values.label')} path={`${at}.when[${at2}].in`} value={condition.in} onChange={(value) => patch({ when: task.when.map((one, k) => (k === at2 ? { ...one, in: value } : one)) })} {...common} />
                    <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-branch-${at2}`} onClick={() => patch({ when: task.when.filter((_, k) => k !== at2) })}>
                      {t('pwf.templates.branch.remove.action')}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || task.when.length >= MAX_CONDITIONS} data-action="add-branch" onClick={() => patch({ when: [...task.when, { field: 'project_group', in: [] }] })}>
                {t('pwf.templates.branch.add.action')}
              </button>
            </fieldset>
              </>
            ),
          },
          {
            id: 'schedule',
            label: t('fix8.editor.part.schedule'),
            count: countOf('schedule'),
            panel: (
              <>
                <div className="pwf-tpl-row">
                  <NumberField label={t('pwf.templates.task.duration.label')} path={`${at}.duration_working_days`} hint={t('pwf.templates.task.duration.hint')} value={task.duration_working_days} onChange={(value) => patch({ duration_working_days: value })} {...common} />
                </div>
            <fieldset className="pwf-tpl-sub">
              <legend>{t('pwf.templates.constraint.legend')}</legend>
              <div className="pwf-tpl-row">
                <SelectField
                  label={t('pwf.templates.constraint.kind.label')}
                  path={`${at}.constraint.kind`}
                  value={task.constraint?.kind ?? 'NONE'}
                  options={[{ value: 'NONE', label: t('pwf.templates.constraint.none.word') }, ...optionsOf(CONSTRAINT_KINDS, (value) => constraintWord(t, value))]}
                  onChange={(value) => patch({ constraint: value === 'NONE' ? null : { kind: value, offset_working_days: task.constraint?.offset_working_days ?? 0 } })}
                  {...common}
                />
                {task.constraint === null ? null : (
                  <NumberField label={t('pwf.templates.constraint.offset.label')} path={`${at}.constraint.offset_working_days`} hint={t('pwf.templates.constraint.offset.hint')} value={task.constraint.offset_working_days} onChange={(value) => patch({ constraint: { kind: task.constraint?.kind ?? 'SNET', offset_working_days: value } })} {...common} />
                )}
              </div>
            </fieldset>
            <fieldset className="pwf-tpl-sub">
              <legend>
                {t('pwf.templates.links.legend')} <Limit name={t('pwf.templates.links.legend')} count={task.predecessors.length} max={MAX_PREDECESSORS} />
              </legend>
              <ul className="pwf-tpl-rows" data-testid="predecessors">
                {task.predecessors.map((link, at2) => (
                  <li key={at2} className="pwf-tpl-row">
                    <SelectField
                      label={t('pwf.templates.link.task.label')}
                      path={`${at}.predecessors[${at2}].task`}
                      value={link.task}
                      options={(others.includes(link.task) ? others : [link.task, ...others]).map((value) => ({ value, label: value }))}
                      onChange={(value) => patch({ predecessors: task.predecessors.map((one, k) => (k === at2 ? { ...one, task: value } : one)) })}
                      {...common}
                    />
                    <SelectField
                      label={t('pwf.templates.link.kind.label')}
                      path={`${at}.predecessors[${at2}].kind`}
                      value={link.kind}
                      options={optionsOf(DEPENDENCY_KINDS, (value) => dependencyWord(t, value))}
                      onChange={(value) => patch({ predecessors: task.predecessors.map((one, k) => (k === at2 ? { ...one, kind: value } : one)) })}
                      {...common}
                    />
                    <NumberField
                      label={t('pwf.templates.link.lag.label')}
                      path={`${at}.predecessors[${at2}].lag_working_days`}
                      hint={t('pwf.templates.link.lag.hint')}
                      value={link.lag_working_days}
                      onChange={(value) => patch({ predecessors: task.predecessors.map((one, k) => (k === at2 ? { ...one, lag_working_days: value } : one)) })}
                      {...common}
                    />
                    <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-link-${at2}`} onClick={() => patch({ predecessors: task.predecessors.filter((_, k) => k !== at2) })}>
                      {t('pwf.templates.link.remove.action')}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="ui-button ui-button--outline ui-button--small"
                disabled={disabled || others.length === 0 || task.predecessors.length >= MAX_PREDECESSORS}
                data-action="add-link"
                onClick={() => {
                  const free = others.find((code) => !task.predecessors.some((link) => link.task === code && link.kind === 'FS'));
                  if (free !== undefined) onChange(addPredecessor(template, index, { task: free, kind: 'FS', lag_working_days: 0 }));
                }}
              >
                {t('pwf.templates.link.add.action')}
              </button>
            </fieldset>
              </>
            ),
          },
          {
            id: 'docs',
            label: t('fix8.editor.part.docs'),
            count: countOf('docs'),
            panel: (
              <>
            <fieldset className="pwf-tpl-sub">
              <legend>{t('pwf.templates.docs.legend')}</legend>
              <div className="pwf-tpl-row">
                <CodeListField label={t('pwf.templates.docs.legal.label')} path={`${at}.legal_doc_types`} hint={t('pwf.templates.docs.legal.hint')} value={task.legal_doc_types} onChange={(value) => patch({ legal_doc_types: value })} {...common} />
                <CodeListField label={t('pwf.templates.docs.forms.label')} path={`${at}.form_templates`} hint={t('pwf.templates.docs.forms.hint')} value={task.form_templates} onChange={(value) => patch({ form_templates: value })} {...common} />
              </div>
              <FormPicker taskCode={task.code} value={task.form_templates} disabled={disabled} onChange={(value) => patch({ form_templates: value })} />
            </fieldset>
            <TaskProcessFields template={template} index={index} task={task} onPatch={patch} problems={problems} show={show} disabled={disabled} part="forms" />
              </>
            ),
          },
          {
            id: 'checklist',
            label: t('fix8.editor.part.checklist'),
            count: countOf('checklist'),
            panel: (
              <>
            <fieldset className="pwf-tpl-sub">
              <legend>
                {t('pwf.templates.checklist.legend')} <Limit name={t('pwf.templates.checklist.legend')} count={task.checklist.length} max={MAX_CHECKLIST} />
              </legend>
              <ul className="pwf-tpl-rows" data-testid="checklist">
                {task.checklist.map((item, at2) => (
                  <li key={at2} className="pwf-tpl-row">
                    <TextField label={t('pwf.templates.checklist.code.label')} path={`${at}.checklist[${at2}].code`} value={item.code} onChange={(value) => patch({ checklist: task.checklist.map((one, k) => (k === at2 ? { ...one, code: value } : one)) })} {...common} />
                    <TextField label={t('pwf.templates.checklist.name.label')} path={`${at}.checklist[${at2}].name`} value={item.name} onChange={(value) => patch({ checklist: task.checklist.map((one, k) => (k === at2 ? { ...one, name: value } : one)) })} {...common} />
                    <CodeListField label={t('pwf.templates.checklist.evidence.label')} path={`${at}.checklist[${at2}].evidence_kinds`} value={item.evidence_kinds} onChange={(value) => patch({ checklist: task.checklist.map((one, k) => (k === at2 ? { ...one, evidence_kinds: value } : one)) })} {...common} />
                    <CheckField label={t('pwf.templates.checklist.required.label')} path={`${at}.checklist[${at2}].required`} checked={item.required} disabled={disabled} onChange={(checked) => patch({ checklist: task.checklist.map((one, k) => (k === at2 ? { ...one, required: checked } : one)) })} />
                    <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled} data-action={`remove-item-${at2}`} onClick={() => patch({ checklist: task.checklist.filter((_, k) => k !== at2) })}>
                      {t('pwf.templates.checklist.remove.action')}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || task.checklist.length >= MAX_CHECKLIST} data-action="add-item" onClick={() => patch({ checklist: [...task.checklist, { code: '', name: '', required: true, evidence_kinds: [] }] })}>
                {t('pwf.templates.checklist.add.action')}
              </button>
            </fieldset>
              </>
            ),
          },
          {
            id: 'kpi',
            label: t('fix8.editor.part.kpi'),
            count: countOf('kpi'),
            panel: (
              <fieldset className="pwf-tpl-sub">
                <legend>{t('fix8.editor.part.kpi')}</legend>
                <div className="pwf-tpl-row">
                    <CodeListField label={t('pwf.templates.docs.kpi.label')} path={`${at}.kpi_codes`} hint={t('pwf.templates.docs.kpi.hint')} value={task.kpi_codes} onChange={(value) => patch({ kpi_codes: value })} {...common} />
                </div>
                  <KpiCodePicker taskCode={task.code} value={task.kpi_codes} disabled={disabled} enabled onChange={(value) => patch({ kpi_codes: value })} />
              </fieldset>
            ),
          },
          {
            id: 'legal',
            label: t('fix8.editor.part.legal'),
            count: countOf('legal'),
            panel: (
              <>
            <TaskProcessFields template={template} index={index} task={task} onPatch={patch} problems={problems} show={show} disabled={disabled} part="legal" />
              </>
            ),
          },
        ]}
      />
      <p className="pwf-actions">
        <button type="button" className="ui-button ui-button--outline" disabled={disabled} data-action="remove-task" onClick={onRemove}>
          {t('pwf.templates.task.remove.action')}
        </button>
      </p>
    </div>
  );
}

// ---- the names of the roles -------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The names of the roles of the template (owner review of 14/11/2026): every role code a step or a task uses has a row here, with the name the shipped catalogue has for it when it has one and a field for the name this template gives
 * it. A code a tenant made up itself has no name anywhere else: named here, every screen of a project that runs this template shows the name and keeps the code as a note. A row left empty stores nothing.
 */
export function RolesPanel({ template, onChange, problems, show, disabled }: PanelProps) {
  const { t } = useTranslation();
  const used = usedRoleCodes(template);
  const declared = template.roles ?? [];
  const codes = [...used, ...declared.map((role) => role.code).filter((code) => !used.includes(code))];
  return (
    <SectionCard title={t('fix8.editor.roles.title')} status={<Limit name={t('fix8.editor.roles.title')} count={declared.length} max={MAX_ROLES} />}>
      <p className="adm-kit-sub">{t('fix8.editor.roles.hint')}</p>
      {codes.length === 0 ? (
        <p className="callout" role="status" data-testid="roles-none">
          {t('fix8.editor.roles.none.text')}
        </p>
      ) : (
        <ul className="pwf-tpl-rows" data-testid="roles">
          {codes.map((code) => {
            const at = declared.findIndex((role) => role.code === code);
            const problem = show && at >= 0 ? (problems.get(`roles[${at}].name`) ?? problems.get(`roles[${at}].code`)) : undefined;
            const id = `pwf-role-name-${code}`;
            return (
              <li key={code} className="pwf-tpl-row" data-role={code}>
                <div className="pwf-field">
                  <label htmlFor={id}>{t('fix8.editor.roles.name.label', { code })}</label>
                  <input id={id} type="text" maxLength={120} value={at < 0 ? '' : (declared[at]?.name ?? '')} disabled={disabled} aria-invalid={problem !== undefined} data-testid={`role-name-${code}`} onChange={(event) => onChange(nameRole(template, code, event.target.value))} />
                  <span className="pwf-hint">
                    {roleKnown(code) ? t('fix8.editor.roles.catalogue.text', { name: roleName(t, code) }) : t('fix8.editor.roles.own.text')}
                    {used.includes(code) ? '' : ` · ${t('fix8.editor.roles.unused.text')}`}
                  </span>
                  {problem === undefined ? null : (
                    <span className="pwf-field__error" data-testid={`error-role-${code}`}>
                      <span aria-hidden="true">⚠ </span>
                      {problemWord(t, problem)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
