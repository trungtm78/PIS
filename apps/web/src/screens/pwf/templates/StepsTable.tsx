import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { gateWord } from '../labels';
import { codeKey } from '../codes';
import { FitSelect, problemWord } from './fields';
import { LegalBasisEditor, BasisStamp } from './legal-basis';
import { problemsOf, roleChoices, unitChoices } from './editor-choices';
import type { Choice } from './editor-choices';
import {
  addNamedPhase,
  addParty,
  addRole,
  addRow,
  addSupport,
  anchorOf,
  anchorTargets,
  basisOfLine,
  basisState,
  dossierCount,
  duplicateLine,
  extensionChoice,
  advancedNotes,
  leadOf,
  limitOf,
  moveLine,
  movePhase,
  nameLine,
  removeLine,
  removePhaseRows,
  setAnchor,
  setBand,
  setExtension,
  setLeadUnit,
  setLimit,
  setRole,
  settleCodes,
  splitStep,
  supportsOf,
  tableOf,
  toggleOverall,
  updateSupport,
  unitRefKind,
} from './table-model';
import type { ExtensionChoice, TableGroup, TableLine } from './table-model';
import { DURATION_UNITS, GATE_TARGETS, MAX_PHASES, MAX_TASKS, MAX_UNITS, stepsOf, uidOf, updatePhase, updateStep, updateTask } from './template-model';
import type { DurationUnit, EditorTask, LegalBasisInput, Template, TemplateProblem } from './template-model';

export interface StepsTableProps {
  template: Template;
  onChange: (next: Template) => void;
  /** The name of a row or a phase was left: the rows that wait for their code get it from the name. Asked of the screen, which applies it to the table as it is at that moment (a handler never settles a copy that an edit has just replaced). */
  onSettle: () => void;
  /** A row was taken away: the screen offers to put it back (the template as it was). */
  onRemoved: (before: Template) => void;
  disabled: boolean;
  /** What the editor itself finds wrong, and whether to say every problem now (the person tried to save) or only those of rows the person has been in. */
  problems: readonly TemplateProblem[];
  showAll: boolean;
  touched: ReadonlySet<string>;
  onTouch: (key: string) => void;
  /** Units of the tenant the lead unit of a step can be (the owner and the parties come with the editor). */
  tenantUnits: readonly { id: string; name: string }[];
  /** The ladder the server judged each task on, by task code (shown as the grey figure of an empty cell: the ladder that applies when the row has none of its own). */
  ladders: ReadonlyMap<string, { green: number | null; yellow: number; red: number }>;
  /** The row whose name takes the caret (a row just added). */
  focusKey: string | undefined;
  onFocused: () => void;
  /** Asks the screen to put the caret in the name of a row (one just added or copied). */
  onFocusRequest: (key: string) => void;
  /** Whether the rows of a phase are shown (a long procedure keeps the phases after the first folded until the person opens them). */
  phaseOpen: (uid: string, index: number) => boolean;
  onTogglePhase: (uid: string, index: number) => void;
  onOpenDetails: (key: string) => void;
}

const asNumber = (value: string): number => (value.trim() === '' ? Number.NaN : Number(value));

/** One message under a cell: the first problem of the cell, said in words (never colour alone). */
function CellProblem({ id, list, t }: { id: string; list: readonly TemplateProblem[]; t: ReturnType<typeof useTranslation>['t'] }) {
  const first = list[0];
  if (first === undefined) return null;
  return (
    <span className="pwfx-cell-error" id={id} data-testid="cell-problem">
      <span aria-hidden="true">⚠ </span>
      {problemWord(t, first.problem)}
    </span>
  );
}

/** A small box for the name of a new unit or role: Enter adds it, Escape leaves. */
function NewName({ label, onAdd, onCancel }: { label: string; onAdd: (name: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const done = (): void => {
    if (name.trim() !== '') onAdd(name.trim());
  };
  return (
    <span className="pwfx-newname">
      <input
        ref={field}
        type="text"
        autoComplete="off"
        maxLength={120}
        aria-label={label}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            done();
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" className="ui-button ui-button--small" disabled={name.trim() === ''} onClick={done}>
        {t('pwfx.new.add')}
      </button>
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onCancel}>
        {t('pwfx.new.cancel')}
      </button>
    </span>
  );
}

export function StepsTable(props: StepsTableProps) {
  const { template, onChange, disabled } = props;
  const { t } = useTranslation();
  const groups = tableOf(template);
  const total = groups.reduce((sum, group) => sum + group.lines.filter((line) => !line.child).length, 0);
  const phaseWord = (group: TableGroup): string => (group.phase === null ? t('pwfx.phase.orphans') : group.phase.name.trim() === '' ? t('pwfx.phase.unnamed') : group.phase.name);
  let phaseNumber = 0;
  return (
    <div className="ui-table-scroll pwfx-scroll" role="region" aria-label={t('pwfx.table.region')} tabIndex={0} data-testid="steps-table">
      <table className="ui-table pwfx-table" data-readonly={disabled ? 'true' : undefined}>
        <caption className="pwfx-sr">{t('pwfx.table.caption', { count: total })}</caption>
        <colgroup>
          <col className="pwfx-w-num" />
          <col className="pwfx-w-name" />
          <col className="pwfx-w-unit" />
          <col className="pwfx-w-anchor" />
          <col className="pwfx-w-limit" />
          <col className="pwfx-w-bands" />
          <col className="pwfx-w-basis" />
          <col className="pwfx-w-dossier" />
          <col className="pwfx-w-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="ui-table__head pwfx-col-num">
              {t('pwfx.col.number')}
            </th>
            <th scope="col" className="ui-table__head pwfx-col-name">
              {t('pwfx.col.step')}
            </th>
            <th scope="col" className="ui-table__head">
              {t('pwfx.col.unit')}
            </th>
            <th scope="col" className="ui-table__head">
              {t('pwfx.col.anchor')}
            </th>
            <th scope="col" className="ui-table__head">
              {t('pwfx.col.limit')}
            </th>
            <th scope="col" className="ui-table__head" title={t('pwfx.col.bands.hint')}>
              {t('pwfx.col.bands')}
            </th>
            <th scope="col" className="ui-table__head">
              {t('pwfx.col.basis')}
            </th>
            <th scope="col" className="ui-table__head">
              {t('pwfx.col.dossier')}
            </th>
            <th scope="col" className="ui-table__head pwfx-col-actions">
              <span className="pwfx-sr">{t('pwfx.col.actions')}</span>
            </th>
          </tr>
        </thead>
        {groups.map((group, groupIndex) => {
          const word = phaseWord(group);
          if (group.phase !== null) phaseNumber += 1;
          const uid = group.phase === null ? 'orphans' : (uidOf(group.phase) ?? group.phase.code);
          const open = group.phase === null || props.phaseOpen(uid, groupIndex);
          return (
            <tbody key={group.phase === null ? `orphans-${groupIndex}` : (uidOf(group.phase) ?? group.phase.code)} data-phase={group.phase?.code ?? ''}>
              <PhaseRow {...props} group={group} word={word} number={group.phase === null ? 0 : phaseNumber} open={open} uid={uid} />
              {open ? group.lines.map((line) => <StepRow key={line.uid} {...props} line={line} />) : null}
              {group.phase === null || disabled || !open ? null : (
                <tr className="pwfx-add">
                  <td colSpan={9}>
                    <button
                      type="button"
                      className="ui-button ui-button--outline ui-button--small"
                      disabled={template.tasks.length >= MAX_TASKS}
                      data-action={`add-step-${group.phase.code}`}
                      onClick={() => {
                        const phase = group.phase;
                        if (phase === null) return;
                        const added = addRow(settleCodes(template), phase.code);
                        if (added === undefined) return;
                        onChange(added.template);
                        props.onFocusRequest(added.key);
                      }}
                    >
                      + {t('pwfx.step.add')}
                    </button>
                    <span className="pwf-hint"> {t('pwfx.step.add.hint')}</span>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
      {disabled ? null : (
        <p className="pwfx-add-phase">
          <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={template.phases.length >= MAX_PHASES} data-action="add-phase" onClick={() => onChange(addNamedPhase(settleCodes(template)))}>
            + {t('pwfx.phase.add')}
          </button>
        </p>
      )}
    </div>
  );
}

// ---- a phase -----------------------------------------------------------------------------------------------------------------------------------------------------------------

function PhaseRow({ template, onChange, onSettle, onRemoved, disabled, group, word, number, open, uid, onTogglePhase }: StepsTableProps & { group: TableGroup; word: string; number: number; open: boolean; uid: string }) {
  const { t } = useTranslation();
  const phase = group.phase;
  const index = group.phaseIndex;
  if (phase === null || index === null) {
    return (
      <tr className="pwfx-phase">
        <th scope="rowgroup" colSpan={9}>
          {word}
        </th>
      </tr>
    );
  }
  const gates = GATE_TARGETS.filter((target) => phase.gates.includes(target));
  return (
    <tr className="pwfx-phase" data-phase-row={phase.code}>
      <th scope="rowgroup" colSpan={9}>
        <div className="pwfx-phase__bar">
          <span className="pwfx-phase__no">{t('pwfx.phase.number', { n: number })}</span>
          <input
            type="text"
            autoComplete="off"
            maxLength={200}
            className="pwfx-phase__name"
            aria-label={t('pwfx.phase.name', { n: number })}
            placeholder={t('pwfx.phase.name.placeholder')}
            value={phase.name}
            disabled={disabled}
            data-testid={`phase-name-${index}`}
            onChange={(event) => onChange(updatePhase(template, index, { name: event.target.value }))}
            onBlur={onSettle}
          />
          <span className="pwf-hint">{t('pwfx.phase.count', { count: group.lines.filter((line) => !line.child).length })}</span>
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={open} data-testid={`phase-toggle-${index}`} onClick={() => onTogglePhase(uid, index)}>
            {open ? t('pwfx.phase.fold') : t('pwfx.phase.unfold')}
          </button>
          {disabled ? null : (
            <span className="pwfx-phase__actions">
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('pwfx.phase.up', { n: number })} disabled={index === 0} onClick={() => onChange(movePhase(template, index, -1))}>
                <span aria-hidden="true">↑</span>
              </button>
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('pwfx.phase.down', { n: number })} disabled={index >= template.phases.length - 1} onClick={() => onChange(movePhase(template, index, 1))}>
                <span aria-hidden="true">↓</span>
              </button>
              <button
                type="button"
                className="ui-button ui-button--outline ui-button--small"
                aria-label={t('pwfx.phase.remove', { n: number })}
                disabled={template.phases.length <= 1}
                onClick={() => {
                  onRemoved(template);
                  onChange(removePhaseRows(template, index));
                }}
              >
                {t('pwfx.phase.remove.short')}
              </button>
            </span>
          )}
        </div>
        <details className="pwfx-gates">
          <summary>{gates.length === 0 ? t('pwfx.gates.none') : t('pwfx.gates.count', { count: gates.length })}</summary>
          <fieldset disabled={disabled}>
            <legend>{t('pwfx.gates.legend')}</legend>
            <p className="pwf-hint">{t('pwfx.gates.hint')}</p>
            {GATE_TARGETS.map((target) => (
              <label key={target} className="pwfx-gates__item">
                <input
                  type="checkbox"
                  checked={phase.gates.includes(target)}
                  onChange={(event) => onChange(updatePhase(template, index, { gates: GATE_TARGETS.filter((one) => (one === target ? event.target.checked : phase.gates.includes(one))) }))}
                />{' '}
                {gateWord(t, target)}
              </label>
            ))}
          </fieldset>
        </details>
      </th>
    </tr>
  );
}

// ---- a step ----------------------------------------------------------------------------------------------------------------------------------------------------------------

function StepRow(props: StepsTableProps & { line: TableLine }) {
  const { template, onChange, onSettle, onRemoved, disabled, line, problems, showAll, touched, onTouch, tenantUnits, ladders, focusKey, onFocused, onOpenDetails } = props;
  const { t } = useTranslation();
  const [adding, setAdding] = useState<'unit' | 'role' | { support: number; part: 'unit' | 'role' } | undefined>(undefined);
  const [basisOpen, setBasisOpen] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey === line.key) {
      nameField.current?.focus();
      onFocused();
    }
  }, [focusKey, line.key, onFocused]);

  const taskIndex = line.taskIndex;
  const task: EditorTask | undefined = taskIndex === null ? undefined : template.tasks[taskIndex];
  const step = line.kind === 'step' && line.stepIndex !== null ? stepsOf(template)[line.stepIndex] : undefined;
  const at = taskIndex === null ? (line.stepIndex === null ? 'tasks[0]' : `steps[${line.stepIndex}]`) : `tasks[${taskIndex}]`;
  const stepAt = line.stepIndex === null ? undefined : `steps[${line.stepIndex}]`;
  const show = showAll || touched.has(line.key);
  const own = (fields: readonly string[]): TemplateProblem[] => {
    if (!show) return [];
    const found = problemsOf(problems, at, fields);
    return stepAt === undefined || stepAt === at ? found : [...found, ...problemsOf(problems, stepAt, fields)];
  };
  const label = (what: string): string => t('pwfx.cell.label', { what, n: line.number });
  const readOnlyLine = disabled;
  const used = [...new Set(template.tasks.map((one) => one.responsible_role).filter((code) => code !== ''))];
  const overall = task !== undefined && template.overall_deadline_task === task.code;
  const nameProblems = own(['name']);
  const unitProblems = own(['responsible_role', 'responsible_units']);
  const anchorProblems = own(['predecessors']);
  const limitProblems = own(['duration', 'duration_working_days', 'extension']);
  const bandProblems = own(['bands']);
  const basisProblems = own(['legal_basis']);
  const detailProblems = show ? problems.filter((problem) => (problem.path.startsWith(`${at}.`) || (stepAt !== undefined && problem.path.startsWith(`${stepAt}.`))) && !['name', 'responsible_role', 'responsible_units', 'predecessors', 'duration', 'duration_working_days', 'extension', 'bands', 'legal_basis', 'code', 'phase', 'step'].includes(problem.path.replace(/^(?:tasks|steps)\[\d+\]\./, '').split(/[.[]/)[0] ?? '')) : [];
  const basis: LegalBasisInput[] = basisOfLine(template, line);
  const ladder = task === undefined ? undefined : ladders.get(task.code);
  const lead = task === undefined ? undefined : leadOf(task);
  const units = unitChoices(t, template, tenantUnits, (task?.responsible_units ?? []).map((unit) => unit.unit_ref));
  const roles = (current: string): Choice[] => roleChoices(t, template, used, current);

  const addAfter = (): void => {
    const added = addRow(settleCodes(template), line.phase);
    if (added === undefined) return;
    onChange(added.template);
    props.onFocusRequest(added.key);
  };
  const phaseLines = tableOf(template).find((group) => group.phase?.code === line.phase)?.lines.filter((one) => !one.child) ?? [];
  const lastOfPhase = phaseLines[phaseLines.length - 1]?.key === line.key;
  const onNameKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && lastOfPhase && !line.child && !readOnlyLine) {
      event.preventDefault();
      addAfter();
    }
  };

  const anchor = task === undefined || taskIndex === null ? undefined : anchorOf(template, taskIndex);
  const targets = taskIndex === null ? [] : anchorTargets(template, taskIndex);
  const limit = task === undefined ? undefined : limitOf(task);
  const choice: ExtensionChoice = task === undefined ? 'unset' : extensionChoice(task);
  const notes = taskIndex === null ? [] : advancedNotes(template, taskIndex);
  const dossier = dossierCount(template, line);
  const supports = task === undefined ? [] : supportsOf(task);

  const remove = (): void => {
    onRemoved(template);
    onChange(removeLine(template, line.key));
  };
  const duplicate = (): void => {
    const copy = duplicateLine(template, line.key, (name) => t('pwfx.step.copy', { name }));
    if (copy === undefined) return;
    onChange(copy.template);
    props.onFocusRequest(copy.key);
  };

  const unitSelect = (value: string, onPick: (ref: string) => void, what: string): ReactNode => (
    <FitSelect
      aria-label={what}
      value={value}
      disabled={readOnlyLine}
      onChange={(event) => {
        if (event.target.value === '~new') setAdding('unit');
        else onPick(event.target.value);
      }}
      data-field="unit"
      data-cell={`${at}.responsible_units`}
    >
      <option value="">{t('pwfx.unit.none')}</option>
      {units.map((choice2) => (
        <option key={choice2.value} value={choice2.value}>
          {choice2.label}
        </option>
      ))}
      <option value="~new">{t('pwfx.unit.new')}</option>
    </FitSelect>
  );
  const roleSelect = (value: string, onPick: (code: string) => void, what: string, support?: number): ReactNode => (
    <FitSelect
      aria-label={what}
      value={value}
      disabled={readOnlyLine}
      onChange={(event) => {
        if (event.target.value === '~new') setAdding(support === undefined ? 'role' : { support, part: 'role' });
        else onPick(event.target.value);
      }}
    >
      <option value="">{t('pwfx.role.none')}</option>
      {roles(value).map((choice2) => (
        <option key={choice2.value} value={choice2.value}>
          {choice2.label}
        </option>
      ))}
      <option value="~new">{t('pwfx.role.new')}</option>
    </FitSelect>
  );

  const unitRow = (): ReactNode => (
    <div className="pwfx-unit">
      {unitSelect(lead?.unit_ref ?? '', (ref) => onChange(setLeadUnit(template, taskIndex as number, ref)), label(t('pwfx.cell.unit')))}
      <span className="pwfx-unit__role">
        {roleSelect((task as EditorTask).responsible_role, (code) => onChange(setRole(template, taskIndex as number, code)), label(t('pwfx.cell.role')))}
        {readOnlyLine || ((task as EditorTask).responsible_units ?? []).length >= MAX_UNITS ? null : (
          <button
            type="button"
            className="pwfx-mini"
            aria-label={label(t('pwfx.cell.support.add'))}
            title={t('pwfx.cell.support.add')}
            onClick={() => {
              const t0 = task as EditorTask;
              const taken = new Set((t0.responsible_units ?? []).map((unit) => `${unit.unit_ref}|${unit.role}`));
              const free = units.find((choice2) => !taken.has(`${choice2.value}|${t0.responsible_role}`));
              if (free !== undefined) onChange(addSupport(template, taskIndex as number, free.value, t0.responsible_role));
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
        )}
      </span>
      {adding === 'unit' ? (
        <NewName
          label={label(t('pwfx.new.unit'))}
          onCancel={() => setAdding(undefined)}
          onAdd={(name) => {
            const made = addParty(template, name);
            onChange(setLeadUnit(made.template, taskIndex as number, `PROJECT_PARTY:${made.code}`));
            setAdding(undefined);
          }}
        />
      ) : null}
      {adding === 'role' ? (
        <NewName
          label={label(t('pwfx.new.role'))}
          onCancel={() => setAdding(undefined)}
          onAdd={(name) => {
            const made = addRole(template, name, (task as EditorTask).responsible_role === '' ? [] : [(task as EditorTask).responsible_role]);
            onChange(setRole(made.template, taskIndex as number, made.code));
            setAdding(undefined);
          }}
        />
      ) : null}
      {supports.map((support, position) => (
        <span key={position} className="pwfx-support">
          {unitSelect(support.unit_ref, (ref) => onChange(updateSupport(template, taskIndex as number, position, { unit_ref: ref })), label(t('pwfx.cell.support.unit', { k: position + 1 })))}
          <span className="pwfx-unit__role">
            {roleSelect(support.role, (code) => onChange(updateSupport(template, taskIndex as number, position, { role: code })), label(t('pwfx.cell.support.role', { k: position + 1 })), position)}
            <button type="button" className="pwfx-mini" disabled={readOnlyLine} aria-label={label(t('pwfx.cell.support.remove', { k: position + 1 }))} onClick={() => onChange(updateSupport(template, taskIndex as number, position, null))}>
              <span aria-hidden="true">✕</span>
            </button>
          </span>
        </span>
      ))}
      {lead === undefined || unitRefKind(lead.unit_ref).kind !== 'unknown' ? null : <span className="pwf-hint">{lead.unit_ref}</span>}
      <CellProblem id={`${line.key}-unit-error`} list={unitProblems} t={t} />
    </div>
  );

  return (
    <>
      <tr className="pwfx-row" data-line={line.key} data-child={line.child ? 'true' : undefined} onBlur={() => onTouch(line.key)} data-testid={`row-${line.key}`}>
        <td className="pwfx-col-num">
          <span className="pwfx-num">{line.number}</span>
          {readOnlyLine ? null : (
            <span className="pwfx-move">
              <button type="button" className="pwfx-mini" aria-label={label(t('pwfx.row.up'))} title={t('pwfx.row.up')} onClick={() => onChange(moveLine(template, line.key, -1))}>
                <span aria-hidden="true">↑</span>
              </button>
              <button type="button" className="pwfx-mini" aria-label={label(t('pwfx.row.down'))} title={t('pwfx.row.down')} onClick={() => onChange(moveLine(template, line.key, 1))}>
                <span aria-hidden="true">↓</span>
              </button>
            </span>
          )}
        </td>
        <td className="pwfx-col-name">
          <div className="pwfx-name">
            <input
              ref={nameField}
              type="text"
              autoComplete="off"
              maxLength={200}
              aria-label={label(t('pwfx.cell.name'))}
              aria-invalid={nameProblems.length > 0}
              placeholder={t('pwfx.cell.name.placeholder')}
              value={task !== undefined && taskIndex !== null && line.kind === 'task' ? task.name : line.name}
              disabled={readOnlyLine}
              data-field="name"
              data-cell={`${at}.name`}
              data-testid={`name-${line.key}`}
              onChange={(event) => onChange(nameLine(template, line, event.target.value))}
              onBlur={onSettle}
              onKeyDown={onNameKey}
            />
            {task === undefined ? null : (
              <button
                type="button"
                className="pwfx-star"
                aria-pressed={overall}
                aria-label={label(t('pwfx.cell.overall'))}
                title={overall ? t('pwfx.cell.overall.text') : t('pwfx.cell.overall.hint')}
                disabled={readOnlyLine || (!overall && /^NEW_\d+$/.test(task.code))}
                data-testid={`overall-${line.key}`}
                onClick={() => onChange(toggleOverall(template, task.code))}
              >
                <span aria-hidden="true">{overall ? '★' : '☆'}</span>
              </button>
            )}
          </div>
          <CellProblem id={`${line.key}-name-error`} list={nameProblems} t={t} />
          {line.kind === 'step' && taskIndex === null ? <span className="pwf-hint">{line.taskIndexes.length === 0 ? t('pwfx.step.empty') : t('pwfx.step.several', { count: line.taskIndexes.length })}</span> : null}
        </td>
        <td>{task === undefined ? <span className="pwf-hint">–</span> : unitRow()}</td>
        <td>
          {task === undefined || taskIndex === null || anchor === undefined ? (
            <span className="pwf-hint">–</span>
          ) : (
            <div className="pwfx-anchor">
              <FitSelect
                aria-label={label(t('pwfx.cell.anchor'))}
                value={anchor.kind === 'start' ? 'start' : anchor.kind === 'after' ? anchor.key : '~advanced'}
                disabled={readOnlyLine}
                data-field="anchor"
                data-cell={`${at}.predecessors`}
                onChange={(event) => {
                  if (event.target.value !== '~advanced') onChange(setAnchor(template, taskIndex, event.target.value));
                }}
              >
                <option value="start">{t('pwfx.anchor.start')}</option>
                {targets.map((target) => (
                  <option key={target.key} value={target.key}>
                    {t('pwfx.anchor.after', { n: target.number })}
                  </option>
                ))}
                {anchor.kind === 'advanced' ? <option value="~advanced">{t('pwfx.anchor.advanced')}</option> : null}
              </FitSelect>
              <CellProblem id={`${line.key}-anchor-error`} list={anchorProblems} t={t} />
              {notes.length === 0 ? null : (
                <>
                  <button type="button" className="pwfx-adv" title={notes.map((note) => noteText(t, note)).join('; ')} data-testid={`advanced-${line.key}`} onClick={() => onOpenDetails(line.key)}>
                    <span aria-hidden="true">⚙ </span>
                    {t('pwfx.cell.advanced', { count: notes.length })}
                  </button>
                  <ul className="pwfx-sr" aria-label={label(t('pwfx.cell.notes'))}>
                    {notes.map((note, position) => (
                      <li key={position} data-note={note.kind}>
                        {noteText(t, note)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </td>
        <td>
          {task === undefined || taskIndex === null || limit === undefined ? (
            <span className="pwf-hint">–</span>
          ) : task.kind === 'MILESTONE' ? (
            <span className="pwf-hint">{t('pwfx.limit.milestone')}</span>
          ) : (
            <div className="pwfx-limit">
              <span className="pwfx-limit__main">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label={label(t('pwfx.cell.limit'))}
                  aria-invalid={limitProblems.length > 0}
                  value={Number.isNaN(limit.value) ? '' : limit.value}
                  disabled={readOnlyLine}
                  data-field="limit"
                  data-cell={`${at}.duration`}
                  data-testid={`limit-${line.key}`}
                  onChange={(event) => onChange(setLimit(template, taskIndex, { value: asNumber(event.target.value) }))}
                />
                <FitSelect aria-label={label(t('pwfx.cell.unitOfLimit'))} value={limit.unit} disabled={readOnlyLine} onChange={(event) => onChange(setLimit(template, taskIndex, { unit: event.target.value as DurationUnit }))}>
                  {DURATION_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`pwfx.limit.unit.${codeKey(unit)}`)}
                    </option>
                  ))}
                </FitSelect>
              </span>
              {limit.unit === 'WORKING_DAY' ? null : (
                <label className="pwfx-check">
                  <input type="checkbox" checked={limit.roll_to_working_day} disabled={readOnlyLine} onChange={(event) => onChange(setLimit(template, taskIndex, { roll_to_working_day: event.target.checked }))} /> {t('pwfx.limit.roll')}
                </label>
              )}
              <label className="pwfx-check" title={choice === 'denied' ? t('pwfx.extension.denied') : undefined}>
                <input
                  type="checkbox"
                  checked={choice === 'allowed'}
                  disabled={readOnlyLine}
                  aria-label={label(t('pwfx.cell.extension'))}
                  onChange={(event) => onChange(setExtension(template, taskIndex, event.target.checked ? 'allowed' : 'unset'))}
                />{' '}
                {t('pwfx.extension.short')}
              </label>
              <CellProblem id={`${line.key}-limit-error`} list={limitProblems} t={t} />
            </div>
          )}
        </td>
        <td>
          {task === undefined || taskIndex === null ? (
            <span className="pwf-hint">–</span>
          ) : (
            <div className="pwfx-bands" title={task.bands === undefined ? t('pwfx.band.followsPolicy') : t('pwfx.band.own')}>
              {(['red_days', 'yellow_days', 'green_days'] as const).map((field) => {
                const word = field === 'red_days' ? t('pwfx.band.red') : field === 'yellow_days' ? t('pwfx.band.yellow') : t('pwfx.band.green');
                const own2 = task.bands?.[field];
                const hint = ladder === undefined ? undefined : field === 'red_days' ? ladder.red : field === 'yellow_days' ? ladder.yellow : (ladder.green ?? undefined);
                return (
                  <label key={field} className={`pwfx-band-label pwfx-band-label--${field.slice(0, field.indexOf('_'))}`}>
                    <span aria-hidden="true">{word}</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      className="pwfx-band"
                      aria-label={label(t('pwfx.cell.band', { color: word }))}
                      aria-invalid={bandProblems.length > 0}
                      placeholder={hint === undefined ? t('pwfx.band.policy') : String(hint)}
                      title={task.bands === undefined ? t('pwfx.band.followsPolicy') : t('pwfx.band.own')}
                      value={own2 === undefined ? '' : Number.isNaN(own2) ? '' : own2}
                      disabled={readOnlyLine}
                      data-field={field === 'red_days' ? 'bands' : undefined}
                      data-cell={field === 'red_days' ? `${at}.bands` : undefined}
                      onChange={(event) => onChange(setBand(template, taskIndex, field, event.target.value.trim() === '' ? undefined : Number(event.target.value)))}
                    />
                  </label>
                );
              })}
              <CellProblem id={`${line.key}-bands-error`} list={bandProblems} t={t} />
            </div>
          )}
        </td>
        <td>
          <div className="pwfx-basis-cell">
            <button type="button" className="pwfx-basis-open" aria-expanded={basisOpen} aria-label={label(t('pwfx.basis.edit'))} title={basis.map((one) => `${one.document}${one.article === undefined || one.article === '' ? '' : ` · ${one.article}`}`).join('; ')} data-field="basis" data-cell={`${at}.legal_basis`} onClick={() => setBasisOpen(!basisOpen)}>
              {basis.length === 0 ? (readOnlyLine ? t('pwfx.basis.none.short') : `+ ${t('pwfx.basis.edit')}`) : `${basis[0]?.document ?? ''}${basis[0]?.article === undefined || basis[0]?.article === '' ? '' : ` · ${basis[0]?.article}`}${basis.length > 1 ? ` +${basis.length - 1}` : ''}`}
            </button>
            {basis.length === 0 ? null : <BasisSummary basis={basis} />}
            <CellProblem id={`${line.key}-basis-error`} list={basisProblems} t={t} />
          </div>
        </td>
        <td>
          <button type="button" className="ui-button ui-button--outline ui-button--small pwfx-dossier" aria-label={label(t('pwfx.dossier.open'))} data-testid={`details-${line.key}`} onClick={() => onOpenDetails(line.key)}>
            {t('pwfx.dossier.count', { count: dossier })} ▸
          </button>
          {detailProblems.length === 0 ? null : (
            <span className="pwfx-cell-error" data-testid="cell-problem">
              <span aria-hidden="true">⚠ </span>
              {t('pwfx.dossier.problems', { count: detailProblems.length })}
            </span>
          )}
        </td>
        <td className="pwfx-col-actions">
          {readOnlyLine ? null : (
            <span className="pwfx-actions">
              <button type="button" className="pwfx-mini" aria-label={label(t('pwfx.row.duplicate'))} title={t('pwfx.row.duplicate')} disabled={template.tasks.length >= MAX_TASKS} onClick={duplicate}>
                <span aria-hidden="true">⧉</span>
              </button>
              {line.kind === 'step' && line.stepIndex !== null ? (
                <button
                  type="button"
                  className="pwfx-mini"
                  aria-label={label(t('pwfx.row.split'))}
                  title={t('pwfx.row.split.hint')}
                  onClick={() => {
                    const split = splitStep(template, line.stepIndex as number);
                    if (split !== undefined) onChange(split.template);
                  }}
                >
                  <span aria-hidden="true">⑂</span>
                </button>
              ) : null}
              <button type="button" className="pwfx-mini" aria-label={label(t('pwfx.row.remove'))} title={t('pwfx.row.remove')} data-testid={`remove-${line.key}`} onClick={remove}>
                <span aria-hidden="true">✕</span>
              </button>
            </span>
          )}
        </td>
      </tr>
      {basisOpen ? (
        <tr className="pwfx-subrow" data-basis-of={line.key}>
          <td />
          <td colSpan={8}>
            {step === undefined || line.stepIndex === null ? null : (
              <div>
                <p className="pwfx-sub-title">{t('pwfx.basis.ofStep')}</p>
                <LegalBasisEditor
                  subject={t('pwfx.basis.subject.step', { n: line.number })}
                  value={step.legal_basis ?? []}
                  disabled={readOnlyLine}
                  cell={`${stepAt ?? at}.legal_basis`}
                  onChange={(next) => onChange(updateStep(template, line.stepIndex as number, { legal_basis: next }))}
                />
              </div>
            )}
            {task === undefined || taskIndex === null ? null : (
              <div>
                {step === undefined ? null : <p className="pwfx-sub-title">{t('pwfx.basis.ofTask')}</p>}
                <LegalBasisEditor
                  subject={t('pwfx.basis.subject.task', { n: line.number })}
                  value={task.legal_basis ?? []}
                  disabled={readOnlyLine}
                  cell={`${at}.legal_basis`}
                  onChange={(next) => onChange(updateTask(template, taskIndex, { legal_basis: next }))}
                />
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** How the grounds of a row stand, in one line: the worst state of any of them (not checked, waiting for the stamp, checked and by whom). */
function BasisSummary({ basis }: { basis: readonly LegalBasisInput[] }) {
  const worst = basis.find((one) => basisState(one) === 'unverified') ?? basis.find((one) => basisState(one) === 'claimed') ?? basis[0];
  return worst === undefined ? null : <BasisStamp basis={worst} />;
}

function noteText(t: ReturnType<typeof useTranslation>['t'], note: ReturnType<typeof advancedNotes>[number]): string {
  switch (note.kind) {
    case 'link':
      return t('pwfx.note.link', { kind: t(`pwfx.note.link.${codeKey(note.link)}`), name: note.name, lag: note.lag });
    case 'constraint':
      return t('pwfx.note.constraint', { kind: t(`pwfx.note.constraint.${codeKey(note.constraint)}`), offset: note.offset });
    case 'conditions':
      return t('pwfx.note.conditions', { count: note.count });
    case 'pinnedForms':
      return t('pwfx.note.pinnedForms', { count: note.count });
    case 'kpi':
      return t('pwfx.note.kpi', { count: note.count });
    case 'approver':
      return t('pwfx.note.approver', { role: note.role });
    case 'optional':
      return t('pwfx.note.optional');
    case 'milestone':
      return t('pwfx.note.milestone');
    case 'priority':
      return t(`pwfx.note.priority.${codeKey(note.priority)}`);
  }
}
