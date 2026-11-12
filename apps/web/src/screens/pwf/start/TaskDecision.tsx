import { useId } from 'react';
import { useTranslation } from '../../../i18n';
import { formProblemText } from '../labels';
import { MAX_EVIDENCE_TEXT, emptyEvidence, evidenceProblem, validateDecision } from './model';
import type { Decision, DecisionErrors, DecisionField, EvidenceDraft } from './model';

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  type?: string;
  testId: string;
  hint?: string;
}

function Field({ label, value, onChange, error, type = 'text', testId, hint }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="pwf-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} data-testid={testId} aria-invalid={error === undefined ? undefined : true} aria-describedby={error === undefined ? undefined : errorId} onChange={(event) => onChange(event.target.value)} />
      {hint === undefined ? null : <span className="pwf-hint">{hint}</span>}
      {error === undefined ? null : (
        <span id={errorId} className="pwf-field__error" data-testid={`${testId}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

interface EvidenceProps {
  code: string;
  index: number;
  item: EvidenceDraft;
  showErrors: boolean;
  onChange: (item: EvidenceDraft) => void;
  onRemove: () => void;
}

function EvidenceFields({ code, index, item, showErrors, onChange, onRemove }: EvidenceProps) {
  const { t } = useTranslation();
  const problem = showErrors ? evidenceProblem(item) : undefined;
  const set = (patch: Partial<EvidenceDraft>): void => onChange({ ...item, ...patch });
  const prefix = `${code}-evidence-${index}`;
  return (
    <fieldset className="pwf-evidence" data-testid={prefix}>
      <legend>{t('pwf.start.evidence.item.legend', { number: index + 1 })}</legend>
      <Field label={t('pwf.start.evidence.kind.label')} value={item.kind} onChange={(kind) => set({ kind })} testId={`${prefix}-kind`} error={problem === 'required' ? formProblemText(t, 'required') : undefined} />
      <Field label={t('pwf.start.evidence.document.label')} value={item.documentId} onChange={(documentId) => set({ documentId })} testId={`${prefix}-document`} />
      <Field label={t('pwf.start.evidence.legal.label')} value={item.legalDocType} onChange={(legalDocType) => set({ legalDocType })} testId={`${prefix}-legal`} />
      <Field label={t('pwf.start.evidence.external.label')} value={item.externalRef} onChange={(externalRef) => set({ externalRef })} testId={`${prefix}-external`} error={problem === 'pickOne' ? t('pwf.start.evidence.pointer.error') : undefined} />
      <Field label={t('pwf.start.evidence.note.label')} value={item.note} onChange={(note) => set({ note: note.slice(0, MAX_EVIDENCE_TEXT) })} testId={`${prefix}-note`} />
      <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`remove-${prefix}`} onClick={onRemove}>
        {t('pwf.start.evidence.remove.action')}
      </button>
    </fieldset>
  );
}

export interface TaskDecisionProps {
  code: string;
  decision: Decision;
  /** True once the person has tried to run or apply: the fields that are not complete say so. */
  showErrors: boolean;
  onChange: (decision: Decision) => void;
}

/** What a person gives for a task of a running project: the days and the evidence of a task that is done, the start and what remains of a task in progress (BR-PWF-17). */
export function TaskDecision({ code, decision, showErrors, onChange }: TaskDecisionProps) {
  const { t } = useTranslation();
  const errors: DecisionErrors = showErrors ? validateDecision(decision) : {};
  const set = (patch: Partial<Decision>): void => onChange({ ...decision, ...patch });
  const text = (field: DecisionField, limits: { min?: number; max?: number } = {}): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : formProblemText(t, problem, limits);
  };
  if (decision.treatment === 'DONE') {
    return (
      <div className="pwf-decision" data-testid={`decision-${code}`}>
        <Field label={t('pwf.start.decision.actualStart.label')} type="date" value={decision.actualStart} onChange={(actualStart) => set({ actualStart })} testId={`${code}-actual-start`} error={text('actualStart')} />
        <Field label={t('pwf.start.decision.actualFinish.label')} type="date" value={decision.actualFinish} onChange={(actualFinish) => set({ actualFinish })} testId={`${code}-actual-finish`} error={text('actualFinish')} />
        {decision.evidence.map((item, index) => (
          <EvidenceFields
            key={index}
            code={code}
            index={index}
            item={item}
            showErrors={showErrors}
            onChange={(next) => set({ evidence: decision.evidence.map((one, at) => (at === index ? next : one)) })}
            onRemove={() => set({ evidence: decision.evidence.filter((_, at) => at !== index) })}
          />
        ))}
        {errors.evidence === 'required' ? (
          <p className="pwf-field__error" role="alert" data-testid={`${code}-evidence-required`}>
            {t('pwf.start.evidence.required.error')}
          </p>
        ) : null}
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`add-${code}-evidence`} onClick={() => set({ evidence: [...decision.evidence, emptyEvidence()] })}>
          {t('pwf.start.evidence.add.action')}
        </button>
      </div>
    );
  }
  if (decision.treatment === 'IN_PROGRESS') {
    return (
      <div className="pwf-decision" data-testid={`decision-${code}`}>
        <Field label={t('pwf.start.decision.actualStart.label')} type="date" value={decision.actualStart} onChange={(actualStart) => set({ actualStart })} testId={`${code}-actual-start`} error={text('actualStart')} />
        <Field label={t('pwf.start.decision.remaining.label')} value={decision.remaining} onChange={(remaining) => set({ remaining })} testId={`${code}-remaining`} error={text('remaining', { min: 0, max: 3650 })} />
        <Field label={t('pwf.start.decision.percent.label')} value={decision.percent} onChange={(percent) => set({ percent })} testId={`${code}-percent`} error={text('percent', { min: 0, max: 100 })} />
      </div>
    );
  }
  return null;
}
