import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { ConfirmDialog } from '../../../ui';
import { Field, describedBy } from './assist-components';
import { useCreateChecklist, useCreateCriteria, useReload } from './assist-hooks';
import { checkKindLabel, errorText, fieldProblemText, severityLabel, weightStateText } from './assist-labels';
import { CHECK_KINDS, MATCHES, MAX_CHECKLIST_ITEMS, MAX_CRITERIA, SEVERITIES, WEIGHT_TOTAL_BP, bpPercent, checklistBody, criteriaBody, emptyChecklist, emptyCriteria, hasChecklistErrors, hasCriteriaErrors, isVersionConflict, newChecklistRow, newCriterionRow, typedWeights, validateChecklist, validateCriteria, weightState, weightsTotal } from './assist-model';
import type { ChecklistErrors, ChecklistForm, ChecklistRowForm, CheckKind, CheckSeverity, CriteriaErrors, CriteriaForm, CriterionRowForm, FieldProblem, TermMatch } from './assist-model';

const problemText = (t: ReturnType<typeof useTranslation>['t'], problem: FieldProblem | undefined): string | undefined => (problem === undefined ? undefined : fieldProblemText(t, problem));

export interface EditorDialogProps {
  onClose: () => void;
  onDone: (receipt: string) => void;
}

// ---- a checklist ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The dialog that writes a draft of a checklist: its code, title and what it applies to, and its items, each with the parameters its kind reads. Nothing is sent until every item passes the rules of the contract. */
export function ChecklistDialog({ onClose, onDone }: EditorDialogProps) {
  const { t } = useTranslation();
  const create = useCreateChecklist();
  const reload = useReload();
  const [form, setForm] = useState<ChecklistForm>(() => emptyChecklist());
  const [errors, setErrors] = useState<ChecklistErrors>({ byRow: {} });
  const [failure, setFailure] = useState<unknown>(undefined);
  const nextKey = useRef(2);
  const sending = useRef(false);
  const setRow = (key: number, change: Partial<ChecklistRowForm>): void => {
    setForm((previous) => ({ ...previous, rows: previous.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
    setErrors({ byRow: {} });
  };
  const confirm = (): void => {
    if (sending.current) return;
    const found = validateChecklist(form);
    setErrors(found);
    if (hasChecklistErrors(found)) return;
    sending.current = true;
    setFailure(undefined);
    create.mutate(checklistBody(form), {
      onSuccess: () => {
        sending.current = false;
        onClose();
        onDone(t('llm.config.checklist.created', { code: form.code.trim() }));
      },
      onError: (error) => {
        sending.current = false;
        setFailure(error);
      },
    });
  };
  const top = (id: string, label: string, value: string, change: (text: string) => void, problem: FieldProblem | undefined, hint?: string, max?: number) => (
    <Field id={id} label={label} error={problemText(t, problem)} hint={hint}>
      <input id={id} value={value} maxLength={max} autoComplete="off" aria-invalid={problem !== undefined} aria-describedby={describedBy(id, hint !== undefined, problem !== undefined)} onChange={(event) => change(event.target.value)} />
    </Field>
  );
  return (
    <ConfirmDialog
      open
      title={t('llm.config.checklist.dialogTitle')}
      context={[]}
      confirmLabel={t('llm.config.checklist.save')}
      cancelLabel={t('llm.config.dialog.cancel')}
      pending={create.isPending}
      {...(failure === undefined ? {} : { error: errorText(t, failure) })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="assist-dialog-body" data-testid="checklist-editor">
        <div className="assist-form-grid">
          {top('cl-code', t('llm.config.field.code'), form.code, (code) => setForm({ ...form, code: code.toUpperCase() }), errors.code, t('llm.config.field.codeHint'), 60)}
          {top('cl-title', t('llm.config.field.title'), form.title, (title) => setForm({ ...form, title }), errors.title, undefined, 300)}
          {top('cl-applies', t('llm.config.field.appliesTo'), form.appliesTo, (appliesTo) => setForm({ ...form, appliesTo: appliesTo.toUpperCase() }), errors.appliesTo, t('llm.config.field.appliesToHint'), 40)}
        </div>
        <p className="sub">{t('llm.config.checklist.itemsHint', { max: MAX_CHECKLIST_ITEMS })}</p>
        <ol className="assist-rows" aria-label={t('llm.config.checklist.items')}>
          {form.rows.map((row, position) => (
            <ChecklistRow key={row.key} row={row} position={position} errors={errors.byRow[row.key] ?? {}} onChange={(change) => setRow(row.key, change)} onRemove={form.rows.length > 1 ? () => setForm({ ...form, rows: form.rows.filter((entry) => entry.key !== row.key) }) : undefined} />
          ))}
        </ol>
        {errors.rows === undefined ? null : (
          <p className="field-error" role="alert">
            {problemText(t, errors.rows)}
          </p>
        )}
        <div className="assist-actions">
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            disabled={form.rows.length >= MAX_CHECKLIST_ITEMS}
            onClick={() => {
              setForm({ ...form, rows: [...form.rows, newChecklistRow(nextKey.current)] });
              nextKey.current += 1;
            }}
          >
            {t('llm.config.checklist.addItem')}
          </button>
          {isVersionConflict(failure) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reload}>
              {t('llm.config.dialog.reload')}
            </button>
          ) : null}
        </div>
      </div>
    </ConfirmDialog>
  );
}

interface ChecklistRowProps {
  row: ChecklistRowForm;
  position: number;
  errors: Partial<Record<'code' | 'label' | 'terms' | 'min' | 'pattern' | 'question', FieldProblem>>;
  onChange: (change: Partial<ChecklistRowForm>) => void;
  onRemove: (() => void) | undefined;
}

function ChecklistRow({ row, position, errors, onChange, onRemove }: ChecklistRowProps) {
  const { t } = useTranslation();
  const id = (name: string): string => `cl-${row.key}-${name}`;
  const text = (name: 'code' | 'label', label: string, value: string, max: number) => (
    <Field id={id(name)} label={label} error={problemText(t, errors[name])}>
      <input id={id(name)} value={value} maxLength={max} autoComplete="off" aria-invalid={errors[name] !== undefined} aria-describedby={describedBy(id(name), false, errors[name] !== undefined)} onChange={(event) => onChange({ [name]: name === 'code' ? event.target.value.toUpperCase() : event.target.value })} />
    </Field>
  );
  return (
    <li className="assist-row" data-row-key={row.key}>
      <strong>{t('llm.config.checklist.itemNumber', { number: position + 1 })}</strong>
      <div className="assist-row-grid">
        {text('code', t('llm.config.item.code'), row.code, 40)}
        {text('label', t('llm.config.item.label'), row.label, 500)}
        <Field id={id('kind')} label={t('llm.config.item.kind')}>
          <select id={id('kind')} value={row.kind} onChange={(event) => onChange({ kind: event.target.value as CheckKind })}>
            {CHECK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {checkKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id('severity')} label={t('llm.config.item.severity')}>
          <select id={id('severity')} value={row.severity} onChange={(event) => onChange({ severity: event.target.value as CheckSeverity })}>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(t, severity)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {row.kind === 'REQUIRED_TERMS' ? (
        <div className="assist-row-grid">
          <Field id={id('terms')} label={t('llm.config.item.terms')} hint={t('llm.config.item.termsHint')} error={problemText(t, errors.terms)}>
            <textarea id={id('terms')} value={row.terms} rows={3} aria-invalid={errors.terms !== undefined} aria-describedby={describedBy(id('terms'), true, errors.terms !== undefined)} onChange={(event) => onChange({ terms: event.target.value })} />
          </Field>
          <Field id={id('match')} label={t('llm.config.item.match')}>
            <select id={id('match')} value={row.match} onChange={(event) => onChange({ match: event.target.value as TermMatch })}>
              {MATCHES.map((match) => (
                <option key={match} value={match}>
                  {t(`llm.config.match.${match === 'ALL' ? 'all' : 'any'}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {row.kind === 'MIN_WORDS' ? (
        <Field id={id('min')} label={t('llm.config.item.min')} error={problemText(t, errors.min)}>
          <input id={id('min')} inputMode="numeric" value={row.min} aria-invalid={errors.min !== undefined} aria-describedby={describedBy(id('min'), false, errors.min !== undefined)} onChange={(event) => onChange({ min: event.target.value })} />
        </Field>
      ) : null}
      {row.kind === 'PATTERN' ? (
        <div className="assist-row-grid">
          <Field id={id('pattern')} label={t('llm.config.item.pattern')} hint={t('llm.config.item.patternHint')} error={problemText(t, errors.pattern)}>
            <input id={id('pattern')} value={row.pattern} autoComplete="off" spellCheck={false} aria-invalid={errors.pattern !== undefined} aria-describedby={describedBy(id('pattern'), true, errors.pattern !== undefined)} onChange={(event) => onChange({ pattern: event.target.value })} />
          </Field>
          <label className="assist-check">
            <input type="checkbox" checked={row.mustMatch} onChange={(event) => onChange({ mustMatch: event.target.checked })} />
            <span>{t('llm.config.item.mustMatch')}</span>
          </label>
        </div>
      ) : null}
      {row.kind === 'AI_QUESTION' ? (
        <Field id={id('question')} label={t('llm.config.item.question')} hint={t('llm.config.item.questionHint')} error={problemText(t, errors.question)}>
          <textarea id={id('question')} value={row.question} rows={2} aria-invalid={errors.question !== undefined} aria-describedby={describedBy(id('question'), true, errors.question !== undefined)} onChange={(event) => onChange({ question: event.target.value })} />
        </Field>
      ) : null}
      {onRemove === undefined ? null : (
        <div className="assist-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRemove}>
            {t('llm.config.item.remove', { number: position + 1 })}
          </button>
        </div>
      )}
    </li>
  );
}

// ---- a set of criteria ------------------------------------------------------------------------------------------------------------------------------------------------------

/** The dialog that writes a draft of a set of criteria: the code, title and top of the scale, and the criteria with their weights in basis points, whose sum is shown live against 10000 (a set is published only when it is exact). */
export function CriteriaDialog({ onClose, onDone }: EditorDialogProps) {
  const { t } = useTranslation();
  const create = useCreateCriteria();
  const reload = useReload();
  const [form, setForm] = useState<CriteriaForm>(() => emptyCriteria());
  const [errors, setErrors] = useState<CriteriaErrors>({ byRow: {} });
  const [failure, setFailure] = useState<unknown>(undefined);
  const nextKey = useRef(2);
  const sending = useRef(false);
  const total = weightsTotal(typedWeights(form));
  const state = weightState(total);
  const setRow = (key: number, change: Partial<CriterionRowForm>): void => {
    setForm((previous) => ({ ...previous, rows: previous.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
    setErrors({ byRow: {} });
  };
  const confirm = (): void => {
    if (sending.current) return;
    const found = validateCriteria(form);
    setErrors(found);
    if (hasCriteriaErrors(found)) return;
    sending.current = true;
    setFailure(undefined);
    create.mutate(criteriaBody(form), {
      onSuccess: () => {
        sending.current = false;
        onClose();
        onDone(t('llm.config.criteria.created', { code: form.code.trim() }));
      },
      onError: (error) => {
        sending.current = false;
        setFailure(error);
      },
    });
  };
  const top = (id: string, label: string, value: string, change: (text: string) => void, problem: FieldProblem | undefined, hint?: string, max?: number) => (
    <Field id={id} label={label} error={problemText(t, problem)} hint={hint}>
      <input id={id} value={value} maxLength={max} autoComplete="off" aria-invalid={problem !== undefined} aria-describedby={describedBy(id, hint !== undefined, problem !== undefined)} onChange={(event) => change(event.target.value)} />
    </Field>
  );
  return (
    <ConfirmDialog
      open
      title={t('llm.config.criteria.dialogTitle')}
      context={[]}
      confirmLabel={t('llm.config.criteria.save')}
      cancelLabel={t('llm.config.dialog.cancel')}
      pending={create.isPending}
      {...(failure === undefined ? {} : { error: errorText(t, failure) })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="assist-dialog-body" data-testid="criteria-editor">
        <div className="assist-form-grid">
          {top('cr-code', t('llm.config.field.code'), form.code, (code) => setForm({ ...form, code: code.toUpperCase() }), errors.code, t('llm.config.field.codeHint'), 60)}
          {top('cr-title', t('llm.config.field.title'), form.title, (title) => setForm({ ...form, title }), errors.title, undefined, 300)}
          {top('cr-scale', t('llm.config.field.scaleMax'), form.scaleMax, (scaleMax) => setForm({ ...form, scaleMax }), errors.scaleMax, t('llm.config.field.scaleMaxHint'), 4)}
        </div>
        <p className="assist-weights" data-testid="weights-sum" data-state={state} role="status">
          {t('llm.config.criteria.sum', { total, target: WEIGHT_TOTAL_BP, percent: bpPercent(total) })} {weightStateText(t, state, { total: String(Math.abs(WEIGHT_TOTAL_BP - total)) })}
        </p>
        <ol className="assist-rows" aria-label={t('llm.config.criteria.rows')}>
          {form.rows.map((row, position) => (
            <CriterionRow key={row.key} row={row} position={position} errors={errors.byRow[row.key] ?? {}} onChange={(change) => setRow(row.key, change)} onRemove={form.rows.length > 1 ? () => setForm({ ...form, rows: form.rows.filter((entry) => entry.key !== row.key) }) : undefined} />
          ))}
        </ol>
        {errors.rows === undefined ? null : (
          <p className="field-error" role="alert">
            {problemText(t, errors.rows)}
          </p>
        )}
        <div className="assist-actions">
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            disabled={form.rows.length >= MAX_CRITERIA}
            onClick={() => {
              setForm({ ...form, rows: [...form.rows, newCriterionRow(nextKey.current)] });
              nextKey.current += 1;
            }}
          >
            {t('llm.config.criteria.addRow')}
          </button>
          {isVersionConflict(failure) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reload}>
              {t('llm.config.dialog.reload')}
            </button>
          ) : null}
        </div>
      </div>
    </ConfirmDialog>
  );
}

interface CriterionRowProps {
  row: CriterionRowForm;
  position: number;
  errors: Partial<Record<'code' | 'label' | 'guidance' | 'weight', FieldProblem>>;
  onChange: (change: Partial<CriterionRowForm>) => void;
  onRemove: (() => void) | undefined;
}

function CriterionRow({ row, position, errors, onChange, onRemove }: CriterionRowProps) {
  const { t } = useTranslation();
  const id = (name: string): string => `cr-${row.key}-${name}`;
  const weight = /^[0-9]+$/.test(row.weight.trim()) ? Number(row.weight.trim()) : undefined;
  return (
    <li className="assist-row" data-row-key={row.key}>
      <strong>{t('llm.config.criteria.rowNumber', { number: position + 1 })}</strong>
      <div className="assist-row-grid">
        <Field id={id('code')} label={t('llm.config.item.code')} error={problemText(t, errors.code)}>
          <input id={id('code')} value={row.code} maxLength={40} autoComplete="off" aria-invalid={errors.code !== undefined} aria-describedby={describedBy(id('code'), false, errors.code !== undefined)} onChange={(event) => onChange({ code: event.target.value.toUpperCase() })} />
        </Field>
        <Field id={id('label')} label={t('llm.config.item.label')} error={problemText(t, errors.label)}>
          <input id={id('label')} value={row.label} maxLength={300} autoComplete="off" aria-invalid={errors.label !== undefined} aria-describedby={describedBy(id('label'), false, errors.label !== undefined)} onChange={(event) => onChange({ label: event.target.value })} />
        </Field>
        <Field id={id('weight')} label={t('llm.config.criteria.weight')} hint={weight === undefined ? undefined : bpPercent(weight)} error={problemText(t, errors.weight)}>
          <input id={id('weight')} inputMode="numeric" value={row.weight} aria-invalid={errors.weight !== undefined} aria-describedby={describedBy(id('weight'), weight !== undefined, errors.weight !== undefined)} onChange={(event) => onChange({ weight: event.target.value })} />
        </Field>
      </div>
      <Field id={id('guidance')} label={t('llm.config.criteria.guidance')} error={problemText(t, errors.guidance)}>
        <textarea id={id('guidance')} value={row.guidance} rows={2} aria-invalid={errors.guidance !== undefined} aria-describedby={describedBy(id('guidance'), false, errors.guidance !== undefined)} onChange={(event) => onChange({ guidance: event.target.value })} />
      </Field>
      <label className="assist-check">
        <input type="checkbox" checked={row.evidenceRequired} onChange={(event) => onChange({ evidenceRequired: event.target.checked })} />
        <span>{t('llm.config.criteria.evidence')}</span>
      </label>
      {onRemove === undefined ? null : (
        <div className="assist-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRemove}>
            {t('llm.config.criteria.remove', { number: position + 1 })}
          </button>
        </div>
      )}
    </li>
  );
}
